"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { createHash, randomUUID } = require("node:crypto");
const { createManagedRuntime } = require("./managed-runtime.cjs");

const START_LOCK_STALE_MS = 60000;
const WORKER_START_GRACE_MS = 20000;

function processIsAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // An inaccessible process is not evidence that it has exited.
    return error.code !== "ESRCH";
  }
}

function readRecord(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function acquireStartLock(directory, isAlive, now) {
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, ".recognition-start.lock");
  for (let attempt = 0; attempt < 2; attempt++) {
    const token = randomUUID();
    let descriptor;
    try {
      descriptor = fs.openSync(file, "wx");
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const record = readRecord(file);
      // Never steal a live owner's lock. A dead owner may be reclaimed;
      // incomplete/corrupt files need a full lease interval to avoid racing
      // another instance between its exclusive open and initial write.
      const validOwner = Number.isSafeInteger(record?.pid) && record.pid > 0;
      let stale = validOwner && !isAlive(record.pid);
      if (!validOwner) {
        try {
          stale = now() - fs.statSync(file).mtimeMs > START_LOCK_STALE_MS;
        } catch (error) {
          if (error.code === "ENOENT") continue;
          throw error;
        }
      }
      if (!stale) return null;
      // Recheck ownership before reclaiming, including when another contender
      // has already replaced the stale record with its own fresh lease.
      const current = readRecord(file);
      if (JSON.stringify(current) !== JSON.stringify(record)) return null;
      try {
        fs.unlinkSync(file);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      continue;
    }
    try {
      fs.writeFileSync(
        descriptor,
        JSON.stringify({ pid: process.pid, createdAt: now(), token }),
      );
    } catch (error) {
      fs.closeSync(descriptor);
      fs.unlinkSync(file);
      throw error;
    }
    fs.closeSync(descriptor);
    return () => {
      if (readRecord(file)?.token === token) fs.unlinkSync(file);
    };
  }
  return null;
}

const unavailable = (message, status = "unavailable") => ({
  status,
  apiReady: false,
  workerReady: false,
  capabilities: { transcribeOnly: false, separate4: false, separate6: false },
  message,
});

function loadConfiguration({
  appPath,
  userData,
  executableDirectory,
  env = process.env,
}) {
  const candidates = env.STEM_STUDIO_CONFIG
    ? [env.STEM_STUDIO_CONFIG]
    : [
        path.join(executableDirectory, "recognition.local.json"),
        path.join(userData, "recognition.local.json"),
        path.resolve(appPath, "..", "recognition.local.json"),
      ];
  const configFile = candidates.find((p) => fs.existsSync(p));
  if (env.STEM_STUDIO_CONFIG && !configFile)
    throw new Error(
      "指定的 recognition.local.json 不存在，请检查本机配置路径。",
    );
  const config = configFile
    ? JSON.parse(fs.readFileSync(configFile, "utf8"))
    : {};
  const base = configFile
    ? path.dirname(configFile)
    : path.resolve(appPath, "..");
  function resolve(value, fallback) {
    return path.resolve(base, value || fallback);
  }
  const origin = new URL(
    env.STEM_STUDIO_API_ORIGIN || config.apiOrigin || "http://127.0.0.1:8000",
  );
  if (
    origin.protocol !== "http:" ||
    origin.hostname !== "127.0.0.1" ||
    origin.username ||
    origin.password ||
    origin.pathname !== "/" ||
    origin.search ||
    origin.hash
  )
    throw new Error("本机识别服务地址必须为 http://127.0.0.1:端口。");
  const dataDirectory = resolve(
    config.dataDirectory,
    path.join(userData, "projects"),
  );
  return {
    managed:
      !configFile &&
      ![
        env.STEM_STUDIO_PYTHON,
        env.STEMWORK_MODEL_PYTHON,
        env.STEMWORK_PIANO_PYTHON,
        env.STEM_STUDIO_BACKEND_DIR,
      ].some(Boolean),
    origin: origin.origin,
    port: Number(origin.port || 80),
    python: resolve(
      env.STEM_STUDIO_PYTHON || config.python,
      ".venv-api/Scripts/python.exe",
    ),
    modelPython: resolve(
      env.STEMWORK_MODEL_PYTHON || config.modelPython,
      ".venv-models/Scripts/python.exe",
    ),
    pianoPython: resolve(
      env.STEMWORK_PIANO_PYTHON ||
        config.pianoPython ||
        env.STEMWORK_MODEL_PYTHON ||
        config.modelPython,
      ".venv-models/Scripts/python.exe",
    ),
    pianoCheckpoint:
      env.STEMWORK_PIANO_CHECKPOINT || config.pianoCheckpoint
        ? resolve(env.STEMWORK_PIANO_CHECKPOINT || config.pianoCheckpoint)
        : "",
    backendDirectory: resolve(
      env.STEM_STUDIO_BACKEND_DIR || config.backendDirectory,
      "backend",
    ),
    dataDirectory,
    modelCacheDirectory: resolve(
      env.STEMWORK_MODEL_CACHE || config.modelCacheDirectory,
      path.join(dataDirectory, "model-cache"),
    ),
    instanceId: createHash("sha256")
      .update(dataDirectory.toLowerCase())
      .digest("hex")
      .slice(0, 24),
  };
}

function createRecognitionService(options, dependencies = {}) {
  // Small injectable boundary for tests: no real process or HTTP server is
  // needed to verify Windows launch flags and cross-instance startup races.
  const spawnChild = dependencies.spawn || spawn;
  const fetchStatus = dependencies.fetch || fetch;
  const isAlive = dependencies.isProcessAlive || processIsAlive;
  const now = dependencies.now || Date.now;
  const platform = dependencies.platform || process.platform;
  let configuration;
  let configurationError;
  try {
    configuration = loadConfiguration(options);
  } catch (error) {
    configurationError = error.message;
  }
  let pending = null;
  let lastError = configurationError;
  let worker = null;
  let apiProcess = null;
  let workerLaunch = null;
  let phase = "unavailable";
  const origin = configuration?.origin || "http://127.0.0.1:8000";
  const managedRuntime = configuration?.managed
    ? createManagedRuntime(options, dependencies)
    : null;

  function runtimeStatus(value) {
    if (value.ready) {
      const runtime = value.configuration;
      for (const key of [
        "python",
        "modelPython",
        "pianoPython",
        "pianoCheckpoint",
        "backendDirectory",
        "modelCacheDirectory",
      ])
        configuration[key] = runtime[key];
      return null;
    }
    return {
      ...unavailable(
        value.setup.message,
        value.setup.stage === "failed" ? "unavailable" : "starting",
      ),
      setup: value.setup,
    };
  }

  async function read(endpoint) {
    const response = await fetchStatus(`${origin}/api/v1${endpoint}`, {
      signal: AbortSignal.timeout(1500),
    });
    if (!response.ok) throw new Error(`本机服务返回 ${response.status}`);
    return response.json();
  }
  async function status() {
    if (managedRuntime) {
      const waiting = runtimeStatus(managedRuntime.status());
      if (waiting) return waiting;
    }
    try {
      if (configuration?.managed) {
        const health = await read("/health");
        if (
          health?.status !== "ok" ||
          health.instanceId !== configuration.instanceId
        )
          return unavailable(
            "本机端口已有其他识别服务。请关闭冲突实例，或为本应用设置独立端口后重试。",
          );
      }
      const value = await read("/system/status");
      if (
        !value ||
        typeof value.workerReady !== "boolean" ||
        !value.capabilities
      )
        throw new Error("识别服务版本不匹配，请升级后端。");
      if (lastError && !value.workerReady)
        return { ...value, status: "unavailable", message: lastError };
      if (
        phase === "starting" &&
        !value.workerReady &&
        ((worker?.pid && worker.exitCode === null) ||
          (workerLaunch?.pid &&
            isAlive(workerLaunch.pid) &&
            now() - workerLaunch.createdAt < WORKER_START_GRACE_MS))
      )
        return {
          ...value,
          status: "starting",
          message: "正在启动本机模型进程…",
        };
      return value;
    } catch {
      return unavailable(
        lastError ||
          (phase === "starting"
            ? "正在启动本机识别服务…"
            : "本机识别服务尚未启动。"),
        phase === "starting" ? "starting" : "unavailable",
      );
    }
  }
  function startProcess(python, args, logName) {
    const c = configuration;
    const logDirectory = path.join(c.dataDirectory, "logs");
    fs.mkdirSync(logDirectory, { recursive: true });
    const log = fs.openSync(path.join(logDirectory, logName), "a");
    const windowlessPython = path.join(path.dirname(python), "pythonw.exe");
    const executable =
      platform === "win32" && fs.existsSync(windowlessPython)
        ? windowlessPython
        : python;
    let child;
    try {
      child = spawnChild(executable, args, {
        cwd: c.backendDirectory,
        shell: false,
        windowsHide: true,
        // detached on Windows can allocate a new console for python.exe and its
        // venv redirector. File-backed stdio + unref already outlive this editor.
        detached: platform !== "win32",
        stdio: ["ignore", log, log],
        env: {
          ...process.env,
          PYTHONUNBUFFERED: "1",
          PYTHONPATH: c.backendDirectory,
          STUDIO_DATA_DIR: c.dataDirectory,
          STUDIO_INSTANCE_ID: c.instanceId,
          STEMWORK_MODEL_PYTHON: c.modelPython,
          STEMWORK_MODEL_CACHE: c.modelCacheDirectory,
          STEMWORK_PIANO_PYTHON: c.pianoPython,
          ...(c.managed ? { HF_HUB_OFFLINE: "1" } : {}),
          ...(c.pianoCheckpoint
            ? { STEMWORK_PIANO_CHECKPOINT: c.pianoCheckpoint }
            : {}),
        },
      });
    } finally {
      fs.closeSync(log);
    }
    child.on("error", (error) => {
      lastError = `无法启动识别服务：${error.message}`;
      phase = "unavailable";
    });
    child.on("exit", (code) => {
      if (code !== 0) {
        lastError = `识别服务意外退出。请重试，详情见本机 ${logName} 日志。`;
        phase = "unavailable";
      }
    });
    // Processing continues when the editor is closed; subsequent launches reuse this service.
    child.unref();
    return child;
  }
  async function startLocked() {
    lastError = configurationError;
    if (!configuration) throw new Error(lastError);
    phase = "starting";
    const c = configuration;
    let health = await read("/health").catch(() => null);
    if (health && health.status !== "ok")
      throw new Error("本机端口已被其他程序占用，请检查识别服务配置。");
    if (health) {
      if (c.managed && health.instanceId !== c.instanceId)
        throw new Error(
          "本机端口已有其他识别服务。请关闭冲突实例，或为本应用设置独立端口后重试。",
        );
      const current = await status();
      if (current.workerReady) {
        phase = "ready";
        return current;
      }
      if (health.instanceId !== c.instanceId)
        throw new Error(
          "检测到已有识别接口，但没有可用的模型进程。请启动该接口对应的 worker，或在识别配置中选择空闲端口。",
        );
    }
    for (const [file, label] of [
      [c.python, "接口 Python"],
      [c.modelPython, "模型 Python"],
      [path.join(c.backendDirectory, "stemwork", "main.py"), "后端源码"],
    ]) {
      if (!fs.existsSync(file))
        throw new Error(
          `未找到${label}。请按使用说明配置 recognition.local.json 后重试。`,
        );
    }
    if (!health) {
      if (!apiProcess?.pid || apiProcess.exitCode !== null)
        apiProcess = startProcess(
          c.python,
          [
            "-m",
            "uvicorn",
            "stemwork.main:create_app",
            "--factory",
            "--host",
            "127.0.0.1",
            "--port",
            String(c.port),
          ],
          "api.log",
        );
      const until = Date.now() + 20000;
      while (!health && Date.now() < until) {
        if (apiProcess.exitCode !== null)
          throw new Error(lastError || "接口启动失败，请查看本机 api.log。");
        await new Promise((resolve) => setTimeout(resolve, 250));
        health = await read("/health").catch(() => null);
      }
      if (!health || health.instanceId !== c.instanceId)
        throw new Error("本机接口未能正常启动，请检查端口和 api.log。");
    }
    const current = await status();
    if (!current.workerReady && (!worker?.pid || worker.exitCode !== null)) {
      const launchFile = path.join(
        c.dataDirectory,
        ".recognition-worker-start.json",
      );
      const previousLaunch = readRecord(launchFile);
      if (previousLaunch?.pid && isAlive(previousLaunch.pid)) {
        workerLaunch = previousLaunch;
        if (now() - previousLaunch.createdAt >= WORKER_START_GRACE_MS)
          return unavailable(
            "识别进程已启动但尚未响应，请查看本机 worker.log；不会重复启动另一个进程。",
          );
        return unavailable("另一个应用实例正在启动本机模型进程…", "starting");
      }
      worker = startProcess(
        c.modelPython,
        ["-m", "stemwork.worker"],
        "worker.log",
      );
      if (worker.pid) {
        workerLaunch = { pid: worker.pid, createdAt: now() };
        fs.writeFileSync(launchFile, JSON.stringify(workerLaunch));
      }
    }
    return status();
  }
  async function start(startOptions) {
    if (!configuration) throw new Error(configurationError);
    if (managedRuntime) {
      const waiting = runtimeStatus(managedRuntime.ensure(startOptions));
      if (waiting) return waiting;
    }
    const release = acquireStartLock(configuration.dataDirectory, isAlive, now);
    if (!release) {
      phase = "starting";
      return unavailable(
        "另一个应用实例正在启动本机识别服务，请稍候…",
        "starting",
      );
    }
    try {
      return await startLocked();
    } finally {
      release();
    }
  }
  return {
    origin,
    status,
    start(startOptions = {}) {
      if (!pending)
        pending = start(startOptions)
          .catch((error) => {
            lastError = error.message;
            phase = "unavailable";
            return unavailable(lastError);
          })
          .finally(() => {
            pending = null;
          });
      return pending;
    },
  };
}

module.exports = { createRecognitionService, loadConfiguration };
