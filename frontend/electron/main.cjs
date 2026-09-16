"use strict";

const {
  app,
  BrowserWindow,
  Menu,
  dialog,
  ipcMain,
  session,
} = require("electron");
const path = require("node:path");
const { writeFile } = require("node:fs/promises");
const { mkdirSync } = require("node:fs");
const { startLocalServer } = require("./server.cjs");
const { createDemoStore } = require("./demo-store.cjs");
const { createRecognitionService } = require("./recognition-service.cjs");

const SAVE_MIDI_CHANNEL = "stem-studio:save-midi";
const MAX_MIDI_BYTES = 32 * 1024 * 1024;
const PRODUCT_NAME = "NoteWise Lab";
const LEGACY_DATA_DIRECTORY_NAME = "stem-studio-desktop";
const runtimeMode = process.argv.includes("--demo") ? "demo" : "api";
let mainWindow = null;
let saveInProgress = false;
let localServer = null;
let recognitionService = null;
let recognitionMonitor = null;

function configureDataDirectory() {
  const requested = process.env.STEM_STUDIO_DATA_DIR;
  if (requested === undefined) {
    // Product branding must not move existing projects or Chromium drafts.
    // Previous releases used package.name as Electron's default directory name.
    const directory = path.join(
      app.getPath("appData"),
      LEGACY_DATA_DIRECTORY_NAME,
    );
    mkdirSync(directory, { recursive: true });
    app.setPath("userData", directory);
    app.setPath("sessionData", directory);
    return;
  }
  if (!path.isAbsolute(requested))
    throw new Error("STEM_STUDIO_DATA_DIR 必须是完整绝对路径。");
  const directory = path.resolve(requested);
  const chromium = path.join(directory, "chromium");
  const logs = path.join(directory, "logs");
  const crashes = path.join(directory, "crash-dumps");
  for (const target of [directory, chromium, logs, crashes])
    mkdirSync(target, { recursive: true });
  // These must be configured before ready, before Chromium initializes its session storage.
  app.setPath("userData", directory);
  app.setPath("sessionData", chromium);
  app.setPath("crashDumps", crashes);
  app.setAppLogsPath(logs);
}

function developmentUrl() {
  // A packaged build always loads bundled files, even when an environment variable is set.
  if (app.isPackaged || !process.env.ELECTRON_RENDERER_URL) return null;
  const url = new URL(process.env.ELECTRON_RENDERER_URL);
  if (
    url.protocol !== "http:" ||
    !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      "ELECTRON_RENDERER_URL must be an HTTP localhost origin, for example http://127.0.0.1:5173/.",
    );
  }
  return url.href;
}

function safeMidiName(value) {
  const input = typeof value === "string" ? value : "未命名工程";
  let basename = path.win32.basename(path.posix.basename(input));
  basename = basename
    .replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, "_")
    .replace(/[. ]+$/g, "");
  basename = basename.replace(/\.(?:mid|midi)$/i, "").slice(0, 100);
  if (
    !basename ||
    /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(basename)
  )
    basename = "音乐工程";
  return `${basename}.mid`;
}

function midiPayload(bytes) {
  if (
    !(bytes instanceof Uint8Array) ||
    bytes.byteLength < 14 ||
    bytes.byteLength > MAX_MIDI_BYTES
  ) {
    throw new TypeError("仅支持不超过 32 MB 的 MIDI 二进制数据。");
  }
  const copy = Buffer.from(bytes);
  if (
    copy.toString("ascii", 0, 4) !== "MThd" ||
    copy.readUInt32BE(4) !== 6 ||
    copy.readUInt16BE(8) > 2 ||
    copy.readUInt16BE(10) < 1
  ) {
    throw new TypeError("导出内容不是有效的标准 MIDI 文件头。");
  }
  return copy;
}

async function createWindow() {
  const rendererUrl = developmentUrl();
  if (!rendererUrl)
    localServer = await startLocalServer(path.join(app.getAppPath(), "dist"), {
      serviceStatus: () => recognitionService.status(),
    });
  const trustedDocument = rendererUrl || `${localServer.origin}/`;

  const window = new BrowserWindow({
    title: PRODUCT_NAME,
    icon: path.join(
      app.getAppPath(),
      app.isPackaged ? "dist" : "public",
      "branding",
      "zhiyinlab-logo.png",
    ),
    width: 1440,
    height: 960,
    minWidth: 1200,
    minHeight: 920,
    show: false,
    backgroundColor: "#f5f5f7",
    autoHideMenuBar: true,
    // Keep the native Windows title bar and system window controls.
    frame: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      devTools: !app.isPackaged,
      additionalArguments: [`--stem-mode=${runtimeMode}`],
    },
  });
  mainWindow = window;
  window.setMenuBarVisibility(false);
  window.once("ready-to-show", () => window.show());
  window.on("closed", () => {
    if (mainWindow === window) mainWindow = null;
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  window.webContents.on("will-frame-navigate", (event) =>
    event.preventDefault(),
  );
  window.webContents.on("will-attach-webview", (event) =>
    event.preventDefault(),
  );

  function assertTrustedSender(event) {
    const senderUrl = event.senderFrame?.url.split("#")[0];
    if (
      event.sender !== window.webContents ||
      event.senderFrame !== window.webContents.mainFrame ||
      senderUrl !== trustedDocument
    )
      throw new Error("无法验证保存请求来源。");
  }
  const demoStore = createDemoStore(app.getPath("userData"));
  ipcMain.removeHandler("stem-studio:enable-recognition");
  ipcMain.handle("stem-studio:enable-recognition", async (event) => {
    assertTrustedSender(event);
    if (runtimeMode === "demo") {
      app.relaunch({
        args: [
          ...process.argv.slice(1).filter((arg) => arg !== "--demo"),
          "--api",
          "--upload",
        ],
      });
      setTimeout(() => app.quit(), 100);
      return;
    }
    const status = await recognitionService.start({ retry: true });
    if (status.status === "unavailable") throw new Error(status.message);
  });
  ipcMain.removeHandler("stem-studio:read-demo");
  ipcMain.handle("stem-studio:read-demo", (event) => {
    assertTrustedSender(event);
    return demoStore.read();
  });
  ipcMain.removeHandler("stem-studio:write-demo");
  ipcMain.handle("stem-studio:write-demo", (event, projects) => {
    assertTrustedSender(event);
    return demoStore.write(projects);
  });

  // Every operation has a fixed purpose. The renderer never supplies a destination path.
  ipcMain.removeHandler(SAVE_MIDI_CHANNEL);
  ipcMain.handle(SAVE_MIDI_CHANNEL, async (event, bytes, proposedName) => {
    assertTrustedSender(event);
    if (saveInProgress) throw new Error("另一个保存窗口仍然打开。");
    const payload = midiPayload(bytes);
    const name = safeMidiName(proposedName);
    saveInProgress = true;
    try {
      const result = await dialog.showSaveDialog(window, {
        title: "导出 MIDI",
        defaultPath: path.join(app.getPath("documents"), name),
        buttonLabel: "保存",
        filters: [{ name: "MIDI 音乐文件", extensions: ["mid"] }],
        properties: ["createDirectory", "showOverwriteConfirmation"],
      });
      if (result.canceled || !result.filePath) return { canceled: true };
      if (!/\.mid$/i.test(result.filePath))
        throw new Error("请选择以 .mid 结尾的文件名。");
      await writeFile(result.filePath, payload);
      return { canceled: false, filePath: result.filePath };
    } finally {
      saveInProgress = false;
    }
  });

  try {
    await window.loadURL(
      trustedDocument + (process.argv.includes("--upload") ? "#/upload" : ""),
    );
  } catch (error) {
    dialog.showErrorBox(
      `${PRODUCT_NAME}无法启动`,
      `${error.message}\n请确认前端已经构建，或开发服务器正在运行。`,
    );
    app.quit();
  }
}

let startupError = null;
try {
  configureDataDirectory();
  app.setName(PRODUCT_NAME);
} catch (error) {
  startupError = error;
}

if (startupError) {
  dialog.showErrorBox(
    "应用数据目录不可用",
    String(startupError.message || startupError),
  );
  app.exit(1);
} else if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on("second-instance", (_event, commandLine) => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
    const requestedMode = commandLine.includes("--demo") ? "demo" : "api";
    if (requestedMode !== runtimeMode) {
      void dialog.showMessageBox(mainWindow, {
        type: "info",
        title: "切换工作模式",
        buttons: ["知道了"],
        message: "请先关闭当前窗口，再使用另一种模式启动。",
        detail: `当前为${runtimeMode === "api" ? "本机识别服务" : "演示"}模式。已保存工程会保留。`,
      });
    }
  });
  app
    .whenReady()
    .then(async () => {
      app.setAppUserModelId("cn.stemstudio.desktop");
      Menu.setApplicationMenu(null);
      session.defaultSession.setPermissionRequestHandler(
        (_webContents, _permission, callback) => callback(false),
      );
      session.defaultSession.setPermissionCheckHandler(() => false);
      recognitionService = createRecognitionService({
        appPath: app.getAppPath(),
        userData: app.getPath("userData"),
        executableDirectory:
          process.env.PORTABLE_EXECUTABLE_DIR || path.dirname(process.execPath),
      });
      process.env.STEM_STUDIO_API_ORIGIN = recognitionService.origin;
      if (runtimeMode === "api") {
        void recognitionService.start();
        recognitionMonitor = setInterval(async () => {
          const status = await recognitionService.status();
          if (!status.workerReady) void recognitionService.start();
        }, 5000);
        recognitionMonitor.unref();
      }
      await createWindow();
    })
    .catch((error) => {
      dialog.showErrorBox(
        `${PRODUCT_NAME}启动失败`,
        String(error.message || error),
      );
      app.quit();
    });
  app.on("window-all-closed", () => app.quit());
  app.on("before-quit", () => {
    clearInterval(recognitionMonitor);
    localServer?.close();
    localServer = null;
  });
}
