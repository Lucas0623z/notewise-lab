"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { createManagedRuntime, readManifest } = require("./managed-runtime.cjs");

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "stem-setup-"));
  const options = {
    userData: path.join(root, "user"),
    resourcesPath: path.join(root, "resources"),
  };
  const directory = path.join(options.userData, "recognition");
  const target = path.join(directory, "runtime");
  const progress = path.join(directory, "setup-progress.json");
  const result = path.join(target, "runtime.json");
  const record = path.join(directory, "setup-process.json");
  const lock = path.join(directory, ".setup-launch.lock");
  const calls = [];
  const live = new Set([process.pid]);
  function write(file, value) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      typeof value === "object" ? JSON.stringify(value) : value,
    );
  }
  write(
    path.join(options.resourcesPath, "runtime/python/pythonw.exe"),
    "not executed",
  );
  write(
    path.join(options.resourcesPath, "backend/setup_runtime.py"),
    "# not executed",
  );
  write(
    path.join(options.resourcesPath, "backend/distribution-manifest.json"),
    { schemaVersion: 1, runtimeRevision: "cpu-test-1" },
  );
  const dependencies = {
    platform: "win32",
    isProcessAlive: (pid) => live.has(pid),
    spawn(executable, args, spawnOptions) {
      const child = new EventEmitter();
      child.pid = 900000 + calls.length;
      child.unref = () => {
        child.unreferenced = true;
      };
      live.add(child.pid);
      calls.push({ executable, args, options: spawnOptions, child });
      return child;
    },
  };
  function complete(revision = "cpu-test-1") {
    const base = path.join(target, "revisions", revision);
    const manifest = {
      schemaVersion: 1,
      runtimeRevision: revision,
      python: path.join(base, "api/Scripts/python.exe"),
      modelPython: path.join(base, "models/Scripts/python.exe"),
      pianoPython: path.join(base, "models/Scripts/python.exe"),
      pianoCheckpoint: path.join(base, "model-cache/piano.pth"),
      backendDirectory: path.join(base, "backend"),
      modelCacheDirectory: path.join(base, "model-cache"),
    };
    for (const key of [
      "python",
      "modelPython",
      "pianoPython",
      "pianoCheckpoint",
    ])
      write(manifest[key], "fixture");
    write(
      path.join(manifest.backendDirectory, "stemwork/main.py"),
      "# fixture",
    );
    write(result, manifest);
    write(progress, { stage: "complete", message: "已验证", updatedAt: "now" });
    return manifest;
  }
  function exit(code) {
    const child = calls.at(-1).child;
    live.delete(child.pid);
    child.emit("exit", code);
  }
  return {
    root,
    options,
    directory,
    target,
    progress,
    result,
    record,
    lock,
    calls,
    live,
    write,
    dependencies,
    complete,
    exit,
    create: () => createManagedRuntime(options, dependencies),
    cleanup() {
      assert.ok(
        path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep),
      );
      assert.ok(path.basename(root).startsWith("stem-setup-"));
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

test("setup launches bundled pythonw with argument array, hidden window and file logs", () => {
  const f = fixture();
  try {
    const runtime = f.create();
    assert.equal(runtime.ensure().setup.stage, "preparing");
    const call = f.calls[0];
    assert.equal(
      call.executable,
      path.join(f.options.resourcesPath, "runtime/python/pythonw.exe"),
    );
    assert.deepEqual(call.args, [
      path.join(f.options.resourcesPath, "backend/setup_runtime.py"),
      "--target",
      f.target,
      "--progress",
      f.progress,
      "--result",
      f.result,
    ]);
    assert.equal(call.options.shell, false);
    assert.equal(call.options.windowsHide, true);
    assert.equal(call.options.detached, false);
    assert.equal(typeof call.options.stdio[1], "number");
    assert.equal(call.options.stdio[1], call.options.stdio[2]);
    assert.throws(() => fs.fstatSync(call.options.stdio[1]), { code: "EBADF" });
    assert.equal(call.child.unreferenced, true);
    f.write(f.progress, {
      stage: "downloading",
      message: "真实下载",
      bytesDownloaded: 30,
      totalBytes: 100,
    });
    assert.equal(runtime.status().setup.bytesDownloaded, 30);
    assert.equal(runtime.status().setup.totalBytes, 100);
    f.write(f.progress, { stage: "installing", message: "pip 安装" });
    assert.equal(runtime.status().setup.totalBytes, null);
    assert.equal(runtime.status().ready, false);
  } finally {
    f.cleanup();
  }
});

test("another instance reuses a live installer even after its editor owner exits", () => {
  const f = fixture();
  try {
    f.create().ensure();
    f.live.delete(process.pid);
    const second = f.create();
    assert.equal(second.ensure({ retry: true }).ready, false);
    assert.equal(f.calls.length, 1);
    f.complete();
    assert.equal(
      second.status().ready,
      false,
      "wait for installer process exit",
    );
    // Simulate completion after the original editor closed: no exit callback
    // updates its launch record, but the script persisted its verified result.
    f.live.delete(f.calls[0].child.pid);
    assert.equal(second.status().ready, true);
    assert.equal(second.ensure().ready, true);
    assert.equal(f.calls.length, 1);
  } finally {
    f.cleanup();
  }
});

test("failure preserves real log details and only explicit retry launches again", () => {
  const f = fixture();
  try {
    const runtime = f.create();
    runtime.ensure();
    f.write(
      path.join(f.directory, "setup.log"),
      "pip failed: connection reset\n",
    );
    f.exit(1);
    assert.equal(runtime.status().setup.stage, "failed");
    assert.match(runtime.status().setup.logTail, /connection reset/);
    assert.equal(f.create().ensure().setup.stage, "failed");
    assert.equal(f.calls.length, 1);
    runtime.ensure({ retry: true });
    assert.equal(f.calls.length, 2);
    f.complete();
    f.exit(0);
    assert.equal(runtime.status().ready, true);
  } finally {
    f.cleanup();
  }
});

test("exit zero without a complete verified manifest is never ready", () => {
  const f = fixture();
  try {
    const runtime = f.create();
    runtime.ensure();
    f.exit(0);
    assert.equal(runtime.status().ready, false);
    assert.equal(runtime.status().setup.stage, "failed");
    runtime.ensure({ retry: true });
    f.complete();
    f.exit(2);
    assert.equal(
      runtime.status().ready,
      false,
      "nonzero exit overrides a result file",
    );
  } finally {
    f.cleanup();
  }
});

test("managed manifests reject missing files and paths outside user runtime", () => {
  const f = fixture();
  try {
    const manifest = f.complete();
    assert.ok(readManifest(f.result, f.target, "cpu-test-1"));
    const outside = path.join(f.root, "outside-python.exe");
    f.write(outside, "fixture");
    f.write(f.result, { ...manifest, python: outside });
    assert.equal(readManifest(f.result, f.target), null);
    f.write(f.result, {
      ...manifest,
      python: path.join(f.target, "missing.exe"),
    });
    assert.equal(readManifest(f.result, f.target), null);
  } finally {
    f.cleanup();
  }
});

test("a new bundled runtime revision installs again instead of using stale dependencies", () => {
  const f = fixture();
  try {
    f.complete("cpu-older");
    f.write(f.record, { pid: null, exitCode: 0 });
    assert.equal(f.create().ensure().ready, false);
    assert.equal(f.calls.length, 1);
  } finally {
    f.cleanup();
  }
});

test("a launch lock respects live owners and recovers dead owners without duplicate install", () => {
  const f = fixture();
  try {
    f.write(f.lock, { pid: process.pid, token: "active" });
    const runtime = f.create();
    runtime.ensure();
    assert.equal(f.calls.length, 0);
    f.write(f.lock, { pid: 88888, token: "dead" });
    runtime.ensure();
    assert.equal(f.calls.length, 1);
    assert.equal(fs.existsSync(f.lock), false);
  } finally {
    f.cleanup();
  }
});

test("missing bundled resources and spawn failures remain unavailable and retryable", () => {
  const f = fixture();
  try {
    const script = path.join(
      f.options.resourcesPath,
      "backend/setup_runtime.py",
    );
    fs.unlinkSync(script);
    const runtime = f.create();
    assert.equal(runtime.ensure().setup.stage, "failed");
    assert.equal(f.calls.length, 0);
    f.write(script, "# recovered");
    runtime.ensure({ retry: true });
    assert.equal(f.calls.length, 1);
    f.calls[0].child.emit("error", new Error("mock access denied"));
    assert.match(runtime.status().setup.message, /mock access denied/);
    assert.equal(fs.existsSync(f.lock), false);
  } finally {
    f.cleanup();
  }
});
