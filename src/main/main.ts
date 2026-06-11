import { app, BrowserWindow, nativeImage } from "electron";
import { join } from "node:path";
import { AutomationBridge } from "./automation-bridge";
import { BrowserHost } from "./browser-host";
import { configureElectronDataPaths } from "./data-paths";
import { createDefaultProfilePartition, createSessionPartition } from "./electron-session-manager";
import { HistoryManager } from "./history-manager";
import { registerInternalProtocol } from "./internal-protocol";
import { registerIpc } from "./ipc";
import { StorageManager } from "./storage-manager";
import { MetadataStore } from "./store";
import { UpdateManager } from "./update-manager";

const isDev = !app.isPackaged;
const isMac = process.platform === "darwin";
const isWin = process.platform === "win32";
const appIconPath = join(app.getAppPath(), "assets", "app-icon.png");
const appIcon = nativeImage.createFromPath(appIconPath);
configureElectronDataPaths();
const hasSingleInstanceLock = app.requestSingleInstanceLock();

let mainWindow: BrowserWindow | undefined;
let isClosingMainWindow = false;

if (isWin) {
  app.setAppUserModelId("com.jarvis-workbench.jarvis-browser");
}

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
    registerInternalProtocol();
    if (!appIcon.isEmpty()) {
      app.dock?.setIcon(appIcon);
    }
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
  const historyManager = new HistoryManager();
  await historyManager.load();
  const storageManager = new StorageManager(historyManager, () =>
    [
      createDefaultProfilePartition(),
      ...store.listSites().flatMap((site) =>
        site.sessions.map((siteSession) => createSessionPartition(site.id, siteSession.id)),
      ),
    ],
  );

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
    icon: appIcon.isEmpty() ? undefined : appIcon,
    webPreferences: {
      preload: join(__dirname, "../preload/preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  const browserHost = new BrowserHost(mainWindow, store, historyManager);
  const updateManager = new UpdateManager(mainWindow);
  const automationBridge = new AutomationBridge(browserHost, store.getAutomationBridgeSettings());
  await automationBridge.applySettings(store.getAutomationBridgeSettings());
  browserHost.bindDefaultDownloads();
  registerIpc(store, browserHost, historyManager, storageManager, updateManager, automationBridge);
  mainWindow.webContents.on("before-input-event", (event, input) => {
    if (browserHost.handleBrowserShortcut(input)) {
      event.preventDefault();
    }
  });
  mainWindow.on("close", (event) => {
    if (isClosingMainWindow) {
      return;
    }

    event.preventDefault();
    isClosingMainWindow = true;
    void browserHost.close().finally(() => {
      void automationBridge.close().finally(() => {
        mainWindow?.destroy();
      });
    });
  });

  mainWindow.on("closed", () => {
    isClosingMainWindow = false;
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
