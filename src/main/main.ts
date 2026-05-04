import { app, BrowserWindow } from "electron";
import { join } from "node:path";
import { registerAssetProtocol } from "./asset-protocol";
import { BrowserHost } from "./browser-host";
import { configureElectronDataPaths } from "./data-paths";
import { registerErrorPageProtocol } from "./error-page";
import { registerIpc } from "./ipc";
import { MetadataStore } from "./store";

const isDev = !app.isPackaged;
const isMac = process.platform === "darwin";
const isWin = process.platform === "win32";
configureElectronDataPaths();
const hasSingleInstanceLock = app.requestSingleInstanceLock();

let mainWindow: BrowserWindow | undefined;

if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!mainWindow) {
      return;
    }

    if (mainWindow.isMinimized()) {
      mainWindow.restore();
    }
    mainWindow.focus();
  });

  app.whenReady().then(async () => {
    registerAssetProtocol();
    registerErrorPageProtocol();
    await createWindow();

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        void createWindow();
      }
    });
  });
}

const createWindow = async () => {
  const store = new MetadataStore();
  await store.load();

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 640,
    titleBarStyle: "hidden",
    trafficLightPosition: isMac ? { x: 14, y: 14 } : undefined,
    titleBarOverlay: isWin
      ? {
        color: "#dee1e6",
        symbolColor: "#3c4043",
        height: 38,
      }
      : undefined,
    webPreferences: {
      preload: join(__dirname, "../preload/preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  const browserHost = new BrowserHost(mainWindow, store);
  browserHost.bindDefaultDownloads();
  registerIpc(store, browserHost);
  mainWindow.webContents.on("before-input-event", (event, input) => {
    if (browserHost.handleBrowserShortcut(input)) {
      event.preventDefault();
    }
  });

  mainWindow.on("closed", () => {
    browserHost.close();
    mainWindow = undefined;
  });

  if (isDev && process.env.VITE_DEV_SERVER_URL) {
    await mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
    return;
  }

  await mainWindow.loadFile(join(__dirname, "../renderer/index.html"));
};

app.on("window-all-closed", () => {
  app.quit();
});
