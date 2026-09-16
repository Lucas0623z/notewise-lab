"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld(
  "desktop",
  Object.freeze({
    platform: "win32",
    mode: process.argv.includes("--stem-mode=api") ? "api" : "demo",
    enableRecognition() {
      return ipcRenderer.invoke("stem-studio:enable-recognition");
    },
    readDemoProjects() {
      return ipcRenderer.invoke("stem-studio:read-demo");
    },
    writeDemoProjects(projects) {
      if (!Array.isArray(projects) || projects.length > 100)
        throw new TypeError("演示工程列表无效。");
      return ipcRenderer.invoke("stem-studio:write-demo", projects);
    },
    async saveMidi(bytes, name) {
      if (
        !ArrayBuffer.isView(bytes) ||
        Object.prototype.toString.call(bytes) !== "[object Uint8Array]" ||
        bytes.byteLength < 14 ||
        bytes.byteLength > 32 * 1024 * 1024
      ) {
        throw new TypeError(
          "saveMidi 需要不超过 32 MB 的 Uint8Array MIDI 数据。",
        );
      }
      if (typeof name !== "string" || name.length > 500)
        throw new TypeError("MIDI 文件名无效。");
      return ipcRenderer.invoke(
        "stem-studio:save-midi",
        new Uint8Array(bytes),
        name,
      );
    },
  }),
);
