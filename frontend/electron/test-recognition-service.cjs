const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const {
  loadConfiguration,
  createRecognitionService,
} = require("./recognition-service.cjs");

test("configuration resolves local paths beside its file and keeps service on loopback", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stem-config-"));
  try {
    const configPath = path.join(dir, "recognition.local.json");
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        python: "runtime/python.exe",
        modelPython: "models/python.exe",
        backendDirectory: "backend",
        dataDirectory: "projects",
        apiOrigin: "http://127.0.0.1:8765",
      }),
    );
    const result = loadConfiguration({
      appPath: dir,
      userData: dir,
      executableDirectory: dir,
      env: {},
    });
    assert.equal(result.python, path.join(dir, "runtime/python.exe"));
    assert.equal(result.port, 8765);
    assert.equal(
      result.instanceId,
      loadConfiguration({
        appPath: dir,
        userData: dir,
        executableDirectory: dir,
        env: {},
      }).instanceId,
    );
    fs.writeFileSync(
      configPath,
      JSON.stringify({ apiOrigin: "https://example.com" }),
    );
    assert.throws(
      () =>
        loadConfiguration({
          appPath: dir,
          userData: dir,
          executableDirectory: dir,
          env: {},
        }),
      /127\.0\.0\.1/,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("invalid configuration returns an unavailable state without spawning", async () => {
  const service = createRecognitionService({
    appPath: __dirname,
    userData: __dirname,
    executableDirectory: __dirname,
    env: { STEM_STUDIO_API_ORIGIN: "https://example.com" },
  });
  const result = await service.start();
  assert.equal(result.status, "unavailable");
  assert.equal(result.workerReady, false);
  assert.equal(result.capabilities.separate4, false);
});

test("without external configuration setup cannot report a foreign API as ready", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stem-managed-service-"));
  try {
    let requests = 0;
    const service = createRecognitionService(
      {
        appPath: dir,
        userData: dir,
        executableDirectory: dir,
        resourcesPath: path.join(dir, "missing-resources"),
        env: { STEM_STUDIO_API_ORIGIN: "http://127.0.0.1:18181" },
      },
      {
        fetch: () => {
          requests++;
          throw new Error("must not use unrelated API");
        },
        spawn: () => assert.fail("incomplete package must not start a process"),
      },
    );
    assert.equal(service.origin, "http://127.0.0.1:18181");
    const result = await service.start();
    assert.equal(result.status, "unavailable");
    assert.equal(result.setup.stage, "failed");
    assert.equal((await service.status()).workerReady, false);
    assert.equal(requests, 0);
  } finally {
    assert.ok(
      path.resolve(dir).startsWith(path.resolve(os.tmpdir()) + path.sep),
    );
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("explicit Python paths and missing explicit config do not silently install a managed runtime", () => {
  const options = {
    appPath: __dirname,
    userData: __dirname,
    executableDirectory: __dirname,
  };
  assert.equal(
    loadConfiguration({
      ...options,
      env: { STEM_STUDIO_PYTHON: "custom/python.exe" },
    }).managed,
    false,
  );
  assert.throws(
    () =>
      loadConfiguration({
        ...options,
        env: {
          STEM_STUDIO_CONFIG: path.join(
            __dirname,
            "missing-config-fixture.json",
          ),
        },
      }),
    /不存在/,
  );
});

function startupFixture({
  windowless = true,
  apiRunning = true,
  workerReadyOnSpawn = true,
} = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stem-launch-"));
  for (const name of [
    "runtime",
    "models",
    "piano",
    "backend/stemwork",
    "projects",
  ]) {
    fs.mkdirSync(path.join(dir, name), { recursive: true });
  }
  for (const name of ["runtime", "models", "piano"]) {
    fs.writeFileSync(
      path.join(dir, name, "python.exe"),
      "mock executable; never launched",
    );
    if (windowless)
      fs.writeFileSync(
        path.join(dir, name, "pythonw.exe"),
        "mock executable; never launched",
      );
  }
  fs.writeFileSync(path.join(dir, "backend/stemwork/main.py"), "# fixture");
  fs.writeFileSync(path.join(dir, "piano/model.pth"), "fixture");
  fs.writeFileSync(
    path.join(dir, "recognition.local.json"),
    JSON.stringify({
      python: "runtime/python.exe",
      modelPython: "models/python.exe",
      pianoPython: "piano/python.exe",
      pianoCheckpoint: "piano/model.pth",
      backendDirectory: "backend",
      dataDirectory: "projects",
    }),
  );
  const options = {
    appPath: dir,
    userData: dir,
    executableDirectory: dir,
    env: {},
  };
  const config = loadConfiguration(options);
  const calls = [];
  const live = new Set([process.pid]);
  let workerReady = false;
  let pid = 700000;
  const dependencies = {
    platform: "win32",
    isProcessAlive: (value) => live.has(value),
    async fetch(url) {
      if (!apiRunning) throw new Error("not listening");
      return {
        ok: true,
        json: async () =>
          url.endsWith("/health")
            ? { status: "ok", instanceId: config.instanceId }
            : {
                status: workerReady ? "ready" : "unavailable",
                apiReady: true,
                workerReady,
                capabilities: {
                  transcribeOnly: workerReady,
                  separate4: workerReady,
                  separate6: workerReady,
                },
                message: workerReady ? "ready" : "worker missing",
              },
      };
    },
    spawn(executable, args, spawnOptions) {
      calls.push({ executable, args, options: spawnOptions });
      const child = new EventEmitter();
      child.pid = ++pid;
      child.exitCode = null;
      child.unref = () => {};
      live.add(child.pid);
      if (args.includes("uvicorn")) apiRunning = true;
      if (args.includes("stemwork.worker")) workerReady = workerReadyOnSpawn;
      return child;
    },
  };
  return {
    dir,
    options,
    config,
    calls,
    dependencies,
    live,
    lock: path.join(config.dataDirectory, ".recognition-start.lock"),
    cleanup() {
      const target = path.resolve(dir);
      assert.ok(target.startsWith(path.resolve(os.tmpdir()) + path.sep));
      assert.ok(path.basename(target).startsWith("stem-launch-"));
      fs.rmSync(target, { recursive: true, force: true });
    },
  };
}

function installedManagedFixture() {
  const fixture = startupFixture();
  fs.unlinkSync(path.join(fixture.dir, "recognition.local.json"));
  const resourcesPath = path.join(fixture.dir, "resources");
  const recognition = path.join(fixture.dir, "recognition");
  const base = path.join(recognition, "runtime", "revisions", "cpu-test-1");
  fs.mkdirSync(path.join(resourcesPath, "backend"), { recursive: true });
  fs.writeFileSync(
    path.join(resourcesPath, "backend/distribution-manifest.json"),
    JSON.stringify({ schemaVersion: 1, runtimeRevision: "cpu-test-1" }),
  );
  for (const name of [
    "api/Scripts",
    "models/Scripts",
    "backend/stemwork",
    "model-cache",
  ])
    fs.mkdirSync(path.join(base, name), { recursive: true });
  for (const environment of ["api", "models"]) {
    for (const binary of ["python.exe", "pythonw.exe"])
      fs.writeFileSync(
        path.join(base, environment, "Scripts", binary),
        "mock executable",
      );
  }
  fs.writeFileSync(path.join(base, "backend/stemwork/main.py"), "# fixture");
  fs.writeFileSync(path.join(base, "model-cache/piano.pth"), "fixture");
  const manifest = {
    schemaVersion: 1,
    runtimeRevision: "cpu-test-1",
    python: path.join(base, "api/Scripts/python.exe"),
    modelPython: path.join(base, "models/Scripts/python.exe"),
    pianoPython: path.join(base, "models/Scripts/python.exe"),
    pianoCheckpoint: path.join(base, "model-cache/piano.pth"),
    backendDirectory: path.join(base, "backend"),
    modelCacheDirectory: path.join(base, "model-cache"),
  };
  fs.writeFileSync(
    path.join(recognition, "runtime/runtime.json"),
    JSON.stringify(manifest),
  );
  fs.writeFileSync(
    path.join(recognition, "setup-progress.json"),
    JSON.stringify({ stage: "complete", message: "verified" }),
  );
  return {
    ...fixture,
    manifest,
    options: {
      ...fixture.options,
      resourcesPath,
      env: { STEM_STUDIO_API_ORIGIN: "http://127.0.0.1:18181" },
    },
  };
}

test("verified managed runtime starts from user data and uses the complete offline model cache", async () => {
  const fixture = installedManagedFixture();
  try {
    const service = createRecognitionService(
      fixture.options,
      fixture.dependencies,
    );
    assert.equal((await service.start()).workerReady, true);
    assert.equal(service.origin, "http://127.0.0.1:18181");
    assert.equal(fixture.calls.length, 1);
    const call = fixture.calls[0];
    assert.equal(
      call.executable,
      path.join(path.dirname(fixture.manifest.modelPython), "pythonw.exe"),
    );
    assert.equal(call.options.cwd, fixture.manifest.backendDirectory);
    assert.equal(
      call.options.env.STEMWORK_MODEL_CACHE,
      fixture.manifest.modelCacheDirectory,
    );
    assert.equal(call.options.env.HF_HUB_OFFLINE, "1");
    assert.equal(
      call.options.env.STEMWORK_PIANO_CHECKPOINT,
      fixture.manifest.pianoCheckpoint,
    );
    assert.equal(
      call.options.env.STUDIO_DATA_DIR,
      path.join(fixture.dir, "projects"),
    );
  } finally {
    fixture.cleanup();
  }
});

test("managed runtime never adopts or starts a worker for another instance's API", async () => {
  const fixture = installedManagedFixture();
  try {
    const service = createRecognitionService(fixture.options, {
      ...fixture.dependencies,
      fetch: async (url) => ({
        ok: true,
        json: async () =>
          url.endsWith("/health")
            ? { status: "ok", instanceId: "another-user-data-directory" }
            : {
                status: "ready",
                workerReady: true,
                capabilities: { transcribeOnly: true },
              },
      }),
    });
    assert.equal((await service.start()).status, "unavailable");
    assert.equal((await service.status()).workerReady, false);
    assert.equal(fixture.calls.length, 0);
  } finally {
    fixture.cleanup();
  }
});

test("API and worker prefer pythonw without consoles, retain file logs and piano environment", async () => {
  const fixture = startupFixture({ apiRunning: false });
  try {
    const service = createRecognitionService(
      fixture.options,
      fixture.dependencies,
    );
    const result = await service.start();
    assert.equal(result.workerReady, true);
    assert.deepEqual(
      fixture.calls.map((call) => call.executable),
      [
        path.join(fixture.dir, "runtime/pythonw.exe"),
        path.join(fixture.dir, "models/pythonw.exe"),
      ],
    );
    for (const call of fixture.calls) {
      assert.equal(call.options.windowsHide, true);
      assert.equal(call.options.detached, false);
      assert.equal(call.options.shell, false);
      assert.equal(call.options.stdio[0], "ignore");
      assert.equal(typeof call.options.stdio[1], "number");
      assert.equal(call.options.stdio[1], call.options.stdio[2]);
      assert.equal(
        call.options.env.STEMWORK_MODEL_PYTHON,
        fixture.config.modelPython,
      );
      assert.equal(
        call.options.env.STEMWORK_PIANO_PYTHON,
        fixture.config.pianoPython,
      );
      assert.equal(
        call.options.env.STEMWORK_PIANO_CHECKPOINT,
        fixture.config.pianoCheckpoint,
      );
    }
    assert.equal(fs.existsSync(fixture.lock), false);
  } finally {
    fixture.cleanup();
  }
});

test("missing pythonw falls back to hidden non-detached console Python", async () => {
  const fixture = startupFixture({ windowless: false });
  try {
    const service = createRecognitionService(
      fixture.options,
      fixture.dependencies,
    );
    assert.equal((await service.start()).workerReady, true);
    assert.equal(fixture.calls.length, 1);
    assert.equal(fixture.calls[0].executable, fixture.config.modelPython);
    assert.equal(fixture.calls[0].options.windowsHide, true);
    assert.equal(fixture.calls[0].options.detached, false);
  } finally {
    fixture.cleanup();
  }
});

test("cross-instance lock and live launch record prevent duplicate workers before their first heartbeat", async () => {
  const fixture = startupFixture({ workerReadyOnSpawn: false });
  try {
    const fetchNormally = fixture.dependencies.fetch;
    let resume;
    let first = true;
    fixture.dependencies.fetch = async (url) => {
      if (first) {
        first = false;
        await new Promise((resolve) => {
          resume = resolve;
        });
      }
      return fetchNormally(url);
    };
    const firstService = createRecognitionService(
      fixture.options,
      fixture.dependencies,
    );
    const secondService = createRecognitionService(
      fixture.options,
      fixture.dependencies,
    );
    const starting = firstService.start();
    assert.equal(fs.existsSync(fixture.lock), true);
    assert.equal((await secondService.start()).status, "starting");
    assert.equal(fixture.calls.length, 0);
    resume();
    await starting;
    assert.equal(fs.existsSync(fixture.lock), false);
    assert.equal((await secondService.start()).status, "starting");
    assert.equal(fixture.calls.length, 1);
    // Even a slow, still-live startup must not cause another worker to spawn.
    const later = createRecognitionService(fixture.options, {
      ...fixture.dependencies,
      now: () => Date.now() + 60000,
    });
    assert.equal((await later.start()).status, "unavailable");
    assert.equal(fixture.calls.length, 1);
  } finally {
    fixture.cleanup();
  }
});

test("dead-owner lock and dead worker launch records are recovered", async () => {
  const fixture = startupFixture();
  try {
    fs.writeFileSync(
      fixture.lock,
      JSON.stringify({ pid: 12345, token: "dead", createdAt: Date.now() }),
    );
    fs.writeFileSync(
      path.join(fixture.config.dataDirectory, ".recognition-worker-start.json"),
      JSON.stringify({ pid: 12345, createdAt: Date.now() }),
    );
    const service = createRecognitionService(
      fixture.options,
      fixture.dependencies,
    );
    assert.equal((await service.start()).workerReady, true);
    assert.equal(fixture.calls.length, 1);
    assert.equal(fs.existsSync(fixture.lock), false);
  } finally {
    fixture.cleanup();
  }
});

test("fresh incomplete locks are respected, stale incomplete locks recover, and live owners are never evicted", async () => {
  const fixture = startupFixture();
  try {
    fs.writeFileSync(fixture.lock, "");
    const service = createRecognitionService(
      fixture.options,
      fixture.dependencies,
    );
    assert.equal((await service.start()).status, "starting");
    assert.equal(fixture.calls.length, 0);
    const old = new Date(Date.now() - 120000);
    fs.utimesSync(fixture.lock, old, old);
    assert.equal((await service.start()).workerReady, true);
    assert.equal(fixture.calls.length, 1);
    fs.writeFileSync(
      fixture.lock,
      JSON.stringify({ pid: process.pid, token: "alive", createdAt: 0 }),
    );
    fs.utimesSync(fixture.lock, old, old);
    assert.equal((await service.start()).status, "starting");
    assert.equal(
      JSON.parse(fs.readFileSync(fixture.lock, "utf8")).token,
      "alive",
    );
  } finally {
    fixture.cleanup();
  }
});

test("failed spawn releases both file descriptor and startup lock, permitting a clean retry", async () => {
  const fixture = startupFixture();
  try {
    const spawnNormally = fixture.dependencies.spawn;
    let logDescriptor;
    let shouldFail = true;
    fixture.dependencies.spawn = (python, args, options) => {
      if (shouldFail) {
        shouldFail = false;
        logDescriptor = options.stdio[1];
        throw new Error("mock spawn failure");
      }
      return spawnNormally(python, args, options);
    };
    const service = createRecognitionService(
      fixture.options,
      fixture.dependencies,
    );
    assert.equal((await service.start()).status, "unavailable");
    assert.equal(fs.existsSync(fixture.lock), false);
    assert.throws(() => fs.fstatSync(logDescriptor), { code: "EBADF" });
    assert.equal((await service.start()).workerReady, true);
  } finally {
    fixture.cleanup();
  }
});
