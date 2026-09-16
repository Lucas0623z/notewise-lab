"use strict";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const source = readFileSync(path.join(__dirname, "main.cjs"), "utf8");

// Exercise startup configuration without launching Electron or writing user data.
function configure(env = {}) {
  const appData = path.resolve("test-app-data");
  const paths = { appData };
  const result = { paths, name: null, errors: [], exitCode: null };
  const app = {
    getPath: (name) => paths[name],
    setPath: (name, value) => {
      paths[name] = value;
    },
    setAppLogsPath: (value) => {
      paths.logs = value;
    },
    setName: (value) => {
      // Persisted data locations must be pinned before changing Electron's name.
      assert.ok(paths.userData);
      assert.ok(paths.sessionData);
      result.name = value;
    },
    requestSingleInstanceLock: () => false,
    quit: () => {},
    exit: (code) => {
      result.exitCode = code;
    },
  };
  const dependencies = {
    electron: {
      app,
      dialog: { showErrorBox: (...args) => result.errors.push(args) },
    },
    "node:path": path,
    "node:fs": { mkdirSync: () => {} },
    "node:fs/promises": { writeFile: () => assert.fail("Unexpected write") },
    "./server.cjs": {},
    "./demo-store.cjs": {},
    "./recognition-service.cjs": {},
  };
  vm.runInNewContext(source, {
    require: (name) => {
      assert.ok(name in dependencies, `Unexpected dependency: ${name}`);
      return dependencies[name];
    },
    process: { env, argv: [] },
  });
  return result;
}

test("NoteWise Lab branding retains the original default project and Chromium directories", () => {
  const result = configure();
  const expected = path.join(result.paths.appData, "stem-studio-desktop");
  assert.equal(result.name, "NoteWise Lab");
  assert.equal(result.paths.userData, expected);
  assert.equal(result.paths.sessionData, expected);
  assert.deepEqual(result.errors, []);
});

test("an explicit data directory keeps its existing Chromium and log subdirectories", () => {
  const directory = path.resolve("test-custom-data");
  const result = configure({ STEM_STUDIO_DATA_DIR: directory });
  assert.equal(result.name, "NoteWise Lab");
  assert.equal(result.paths.userData, directory);
  assert.equal(result.paths.sessionData, path.join(directory, "chromium"));
  assert.equal(result.paths.logs, path.join(directory, "logs"));
  assert.equal(result.paths.crashDumps, path.join(directory, "crash-dumps"));
  assert.deepEqual(result.errors, []);
});

test("invalid custom paths still stop startup instead of falling back to new data", () => {
  const result = configure({ STEM_STUDIO_DATA_DIR: "relative-data" });
  assert.equal(result.name, null);
  assert.equal(result.exitCode, 1);
  assert.equal(result.paths.userData, undefined);
  assert.match(result.errors[0][1], /必须是完整绝对路径/);
});
