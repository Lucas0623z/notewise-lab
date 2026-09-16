"use strict";

const { spawn } = require("node:child_process");
const http = require("node:http");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const host = "127.0.0.1";
const port = 5173;
const url = `http://${host}:${port}/`;
const viteEntry = path.join(
  path.dirname(require.resolve("vite/package.json")),
  "bin",
  "vite.js",
);
const electronBinary = require("electron");
const children = new Set();
let shuttingDown = false;

function run(binary, args, env = process.env) {
  const child = spawn(binary, args, {
    cwd: root,
    env,
    shell: false,
    windowsHide: true,
    stdio: "inherit",
  });
  children.add(child);
  child.once("exit", () => children.delete(child));
  child.once("error", (error) => {
    console.error(error.message);
    shutdown(1);
  });
  return child;
}

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) child.kill();
  process.exitCode = code;
}

function isReady() {
  return new Promise((resolve) => {
    const request = http.get(url, (response) => {
      response.resume();
      resolve(response.statusCode === 200);
    });
    request.setTimeout(700, () => request.destroy());
    request.on("error", () => resolve(false));
  });
}

async function main() {
  // Never attach the privileged preload to an unrelated server already listening on this port.
  if (await isReady())
    throw new Error(
      "5173 端口已被占用。请先停止现有开发服务器，再运行 dev:desktop。",
    );
  const vite = run(process.execPath, [
    viteEntry,
    "--host",
    host,
    "--port",
    String(port),
    "--strictPort",
  ]);
  vite.once("exit", (code) => {
    if (!shuttingDown) shutdown(code || 1);
  });
  const deadline = Date.now() + 30000;
  while (!shuttingDown && Date.now() < deadline) {
    if (await isReady()) {
      if (vite.exitCode !== null) throw new Error("前端开发服务器已退出。");
      const env = { ...process.env, ELECTRON_RENDERER_URL: url };
      // An enclosing Node/Electron tool may set this; the GUI child must run as Electron.
      delete env.ELECTRON_RUN_AS_NODE;
      const electron = run(
        electronBinary,
        [root, ...(process.argv.includes("--demo") ? ["--demo"] : ["--api"])],
        env,
      );
      electron.once("exit", (code) => shutdown(code || 0));
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  if (!shuttingDown) throw new Error("前端开发服务器未能在 30 秒内启动。");
}

process.on("SIGINT", () => shutdown());
process.on("SIGTERM", () => shutdown());
main().catch((error) => {
  console.error(error.message);
  shutdown(1);
});
