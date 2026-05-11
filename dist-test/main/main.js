"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const electron_1 = require("electron");
const node_path_1 = require("node:path");
const browser_host_1 = require("./browser-host");
const data_paths_1 = require("./data-paths");
const electron_session_manager_1 = require("./electron-session-manager");
const history_manager_1 = require("./history-manager");
const internal_protocol_1 = require("./internal-protocol");
const ipc_1 = require("./ipc");
const storage_manager_1 = require("./storage-manager");
const store_1 = require("./store");
const isDev = !electron_1.app.isPackaged;
const isMac = process.platform === "darwin";
const isWin = process.platform === "win32";
const appIconPath = (0, node_path_1.join)(electron_1.app.getAppPath(), "assets", "app-icon.png");
const appIcon = electron_1.nativeImage.createFromPath(appIconPath);
(0, data_paths_1.configureElectronDataPaths)();
const hasSingleInstanceLock = electron_1.app.requestSingleInstanceLock();
let mainWindow;
let isClosingMainWindow = false;
if (!hasSingleInstanceLock) {
    electron_1.app.quit();
}
else {
    electron_1.app.on("second-instance", () => {
        if (!mainWindow) {
            return;
        }
        if (mainWindow.isMinimized()) {
            mainWindow.restore();
        }
        mainWindow.focus();
    });
    electron_1.app.whenReady().then(async () => {
        (0, internal_protocol_1.registerInternalProtocol)();
        if (!appIcon.isEmpty()) {
            electron_1.app.dock?.setIcon(appIcon);
        }
        await createWindow();
        electron_1.app.on("activate", () => {
            if (electron_1.BrowserWindow.getAllWindows().length === 0) {
                void createWindow();
            }
        });
    });
}
const createWindow = async () => {
    const store = new store_1.MetadataStore();
    await store.load();
    const historyManager = new history_manager_1.HistoryManager();
    await historyManager.load();
    const storageManager = new storage_manager_1.StorageManager(historyManager, () => [
        (0, electron_session_manager_1.createDefaultProfilePartition)(),
        ...store.listSites().flatMap((site) => site.sessions.map((siteSession) => (0, electron_session_manager_1.createSessionPartition)(site.id, siteSession.id))),
    ]);
    mainWindow = new electron_1.BrowserWindow({
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
            preload: (0, node_path_1.join)(__dirname, "../preload/preload.js"),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: false,
        },
    });
    const browserHost = new browser_host_1.BrowserHost(mainWindow, store, historyManager);
    browserHost.bindDefaultDownloads();
    (0, ipc_1.registerIpc)(store, browserHost, historyManager, storageManager);
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
            mainWindow?.destroy();
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
    await mainWindow.loadFile((0, node_path_1.join)(__dirname, "../renderer/index.html"));
};
electron_1.app.on("window-all-closed", () => {
    electron_1.app.quit();
});
