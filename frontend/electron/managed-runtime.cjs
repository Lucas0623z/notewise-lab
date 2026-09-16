"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { randomUUID } = require("node:crypto");

const STAGES = new Set([
  "preparing",
  "downloading",
  "installing",
  "verifying",
  "complete",
  "failed",
]);
const STALE_LOCK_MS = 60000;

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function writeJson(file, value) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(value));
    fs.renameSync(temporary, file);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

function processIsAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== "ESRCH";
  }
}

function logTail(file) {
  let descriptor;
  try {
    descriptor = fs.openSync(file, "r");
    const size = fs.fstatSync(descriptor).size;
    const bytes = Buffer.alloc(Math.min(size, 8192));
    fs.readSync(
      descriptor,
      bytes,
      0,
      bytes.length,
      Math.max(0, size - bytes.length),
    );
    return bytes
      .toString("utf8")
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "")
      .trim();
  } catch {
    return "";
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

/** The setup script owns dependency/model verification; never trust paths outside its target. */
function readManifest(file, target, expectedRevision) {
  const value = readJson(file);
  if (
    value?.schemaVersion !== 1 ||
    typeof value.runtimeRevision !== "string" ||
    !value.runtimeRevision
  )
    return null;
  if (expectedRevision && value.runtimeRevision !== expectedRevision)
    return null;
  try {
    const root = fs.realpathSync(target);
    for (const key of [
      "python",
      "modelPython",
      "pianoPython",
      "pianoCheckpoint",
      "backendDirectory",
      "modelCacheDirectory",
    ]) {
      if (typeof value[key] !== "string" || !path.isAbsolute(value[key]))
        return null;
      const actual = fs.realpathSync(value[key]);
      const relative = path.relative(root, actual);
      if (
        !relative ||
        relative === ".." ||
        relative.startsWith(`..${path.sep}`) ||
        path.isAbsolute(relative)
      )
        return null;
      const directory =
        key === "backendDirectory" || key === "modelCacheDirectory";
      if (
        directory
          ? !fs.statSync(actual).isDirectory()
          : !fs.statSync(actual).isFile()
      )
        return null;
    }
    if (
      !fs.existsSync(path.join(value.backendDirectory, "stemwork", "main.py"))
    )
      return null;
    return value;
  } catch {
    return null;
  }
}

function createManagedRuntime(options, dependencies = {}) {
  const launch = dependencies.spawn || spawn;
  const isAlive = dependencies.isProcessAlive || processIsAlive;
  const now = dependencies.now || Date.now;
  const platform = dependencies.platform || process.platform;
  const directory = path.join(options.userData, "recognition");
  const target = path.join(directory, "runtime");
  const progressFile = path.join(directory, "setup-progress.json");
  const resultFile = path.join(target, "runtime.json");
  const processFile = path.join(directory, "setup-process.json");
  const lockFile = path.join(directory, ".setup-launch.lock");
  const logPath = path.join(directory, "setup.log");
  const resources = options.resourcesPath || process.resourcesPath;
  const distribution =
    resources &&
    readJson(path.join(resources, "backend", "distribution-manifest.json"));
  const expectedRevision =
    distribution?.schemaVersion === 1 &&
    typeof distribution.runtimeRevision === "string" &&
    /^[A-Za-z0-9._-]+$/.test(distribution.runtimeRevision)
      ? distribution.runtimeRevision
      : null;
  let localError = null;

  function failed(message) {
    return {
      ready: false,
      setup: {
        stage: "failed",
        message,
        bytesDownloaded: null,
        totalBytes: null,
        logPath,
        logTail: logTail(logPath),
      },
    };
  }

  function status() {
    if (localError) return failed(localError);
    const record = readJson(processFile);
    const progress = readJson(progressFile);
    const active = !!record?.pid && isAlive(record.pid);
    if (!active && record?.error) return failed(record.error);
    if (progress?.stage === "failed")
      return failed(progress.message || "识别环境安装失败，请重试。");
    if (!active && (record?.exitCode === undefined || record.exitCode === 0)) {
      const configuration =
        expectedRevision && readManifest(resultFile, target, expectedRevision);
      if (configuration && progress?.stage === "complete")
        return { ready: true, configuration, setup: null };
    }
    const oldRevision = readJson(resultFile)?.runtimeRevision;
    const needsUpgrade =
      expectedRevision && oldRevision && oldRevision !== expectedRevision;
    if (record && !active && !needsUpgrade)
      return failed(
        "识别环境安装未完成，或已安装文件需要修复。点击重试可继续准备。",
      );
    const stage =
      active && STAGES.has(progress?.stage) && progress.stage !== "complete"
        ? progress.stage
        : "preparing";
    const bytesDownloaded =
      Number.isFinite(progress?.bytesDownloaded) &&
      progress.bytesDownloaded >= 0
        ? progress.bytesDownloaded
        : null;
    const totalBytes =
      Number.isFinite(progress?.totalBytes) &&
      progress.totalBytes > 0 &&
      (bytesDownloaded === null || progress.totalBytes >= bytesDownloaded)
        ? progress.totalBytes
        : null;
    return {
      ready: false,
      setup: {
        stage,
        message: active
          ? progress?.message || "正在准备本机识别环境…"
          : "首次使用需要下载并安装本机识别组件。",
        bytesDownloaded: active ? bytesDownloaded : null,
        totalBytes: active ? totalBytes : null,
        logPath,
      },
    };
  }

  function acquireLock() {
    fs.mkdirSync(directory, { recursive: true });
    for (let attempt = 0; attempt < 2; attempt++) {
      const token = randomUUID();
      let fd;
      try {
        fd = fs.openSync(lockFile, "wx");
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
        const owner = readJson(lockFile);
        if (
          owner?.pid
            ? isAlive(owner.pid)
            : now() - fs.statSync(lockFile).mtimeMs <= STALE_LOCK_MS
        )
          return null;
        if (JSON.stringify(readJson(lockFile)) !== JSON.stringify(owner))
          return null;
        try {
          fs.unlinkSync(lockFile);
        } catch (cause) {
          if (cause.code !== "ENOENT") throw cause;
        }
        continue;
      }
      try {
        fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, token }));
      } finally {
        fs.closeSync(fd);
      }
      return () => {
        if (readJson(lockFile)?.token === token) fs.unlinkSync(lockFile);
      };
    }
    return null;
  }

  function ensure({ retry = false } = {}) {
    if (retry) localError = null;
    let current = status();
    if (current.ready || (!retry && current.setup.stage === "failed"))
      return current;
    let release;
    try {
      release = acquireLock();
      if (!release) return current;
      // Recheck after acquiring the launch lease; a surviving setup child owns the install.
      const previous = readJson(processFile);
      if (previous?.pid && isAlive(previous.pid)) return status();
      current = status();
      if (current.ready || (!retry && current.setup.stage === "failed"))
        return current;
      const python =
        resources && path.join(resources, "runtime", "python", "pythonw.exe");
      const script =
        resources && path.join(resources, "backend", "setup_runtime.py");
      if (
        !python ||
        !script ||
        !expectedRevision ||
        !fs.existsSync(python) ||
        !fs.existsSync(script)
      )
        throw new Error("安装包中的识别组件不完整，请重新安装应用后重试。");
      const token = randomUUID();
      writeJson(progressFile, {
        stage: "preparing",
        message: "正在准备本机识别环境…",
        updatedAt: new Date(now()).toISOString(),
      });
      const fd = fs.openSync(logPath, "a");
      const env = {
        ...process.env,
        PYTHONUNBUFFERED: "1",
        PYTHONNOUSERSITE: "1",
        PIP_DISABLE_PIP_VERSION_CHECK: "1",
      };
      delete env.PYTHONHOME;
      delete env.PYTHONPATH;
      let child;
      try {
        child = launch(
          python,
          [
            script,
            "--target",
            target,
            "--progress",
            progressFile,
            "--result",
            resultFile,
          ],
          {
            cwd: path.dirname(script),
            env,
            shell: false,
            windowsHide: true,
            detached: platform !== "win32",
            stdio: ["ignore", fd, fd],
          },
        );
      } finally {
        fs.closeSync(fd);
      }
      writeJson(processFile, {
        token,
        pid: child.pid || null,
        ownerPid: process.pid,
        startedAt: now(),
      });
      function finished(code, error) {
        const record = readJson(processFile);
        if (record?.token !== token) return;
        const message = error
          ? `无法准备识别环境：${error.message}`
          : code !== 0
            ? `识别环境安装失败（退出代码 ${code ?? "未知"}）。请查看安装日志后重试。`
            : null;
        try {
          writeJson(processFile, {
            ...record,
            pid: null,
            exitCode: code,
            error: message,
            endedAt: now(),
          });
        } catch (cause) {
          localError = `无法保存识别环境安装状态：${cause.message}`;
        }
      }
      child.once("error", (error) => finished(null, error));
      child.once("exit", (code) => finished(code, null));
      // File-backed streams let installation finish after the editor window closes.
      child.unref();
      return status();
    } catch (error) {
      localError = error.message;
      return failed(localError);
    } finally {
      release?.();
    }
  }

  return { ensure, status };
}

module.exports = { createManagedRuntime, readManifest };
