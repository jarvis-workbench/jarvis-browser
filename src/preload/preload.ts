import { contextBridge, ipcRenderer } from "electron";
import type { AppApi, BrowserRect, BrowserState, DownloadSettings, DownloadState, JarvisScript, JarvisScriptMessage, Site, SiteExtension, WindowChromeInfo } from "../shared/types";

const invoke = <T>(channel: string, ...args: unknown[]) =>
  ipcRenderer.invoke(channel, ...args) as Promise<T>;

const on = <Args extends unknown[]>(channel: string, callback: (...args: Args) => void) => {
  const listener = (_event: Electron.IpcRendererEvent, ...args: Args) => callback(...args);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};

const isMac = process.platform === "darwin";
const isWindows = process.platform === "win32";
const windowChrome: WindowChromeInfo = {
  platform: process.platform,
  isMac,
  isWindows,
  titlebarHeight: 38,
  titlebarLeftInset: isMac ? 88 : 0,
  titlebarRightInset: isWindows ? 138 : 0,
  capsuleWidth: 0,
  capsuleGap: 0,
};

const appApi: AppApi = {
  sites: {
    list: () => invoke("sites:list"),
    add: (input) => invoke("sites:add", input),
    update: (siteId, input) => invoke("sites:update", siteId, input),
    delete: (siteId) => invoke("sites:delete", siteId),
  },
  sessions: {
    add: (siteId, input) => invoke("sessions:add", siteId, input),
    rename: (siteId, sessionId, name) => invoke("sessions:rename", siteId, sessionId, name),
    delete: (siteId, sessionId) => invoke("sessions:delete", siteId, sessionId),
    clearData: (siteId, sessionId, options) => invoke("sessions:clear-data", siteId, sessionId, options),
  },
  browser: {
    open: (siteId, sessionId) => invoke("browser:open", siteId, sessionId),
    navigate: (url) => invoke("browser:navigate", url),
    back: () => invoke("browser:back"),
    forward: () => invoke("browser:forward"),
    reload: () => invoke("browser:reload"),
    stop: () => invoke("browser:stop"),
    showHome: () => invoke("browser:show-home"),
    hideEmbeddedView: () => invoke("browser:hide-embedded-view"),
    showActiveView: () => invoke("browser:show-active-view"),
    setBounds: (rect: BrowserRect) => invoke("browser:set-bounds", rect),
    close: () => invoke("browser:close"),
    closeSession: (siteId, sessionId) => invoke("browser:close-session", siteId, sessionId),
    debugState: () => invoke("browser:debug-state"),
  },
  extensions: {
    listGlobal: () => invoke<SiteExtension[]>("extensions:list-global"),
    listSite: (siteId: string) => invoke<SiteExtension[]>("extensions:list-site", siteId),
    installGlobal: () => invoke("extensions:install-global"),
    installSite: (siteId) => invoke("extensions:install-site", siteId),
    enableGlobal: (extensionId) => invoke("extensions:enable-global", extensionId),
    disableGlobal: (extensionId) => invoke("extensions:disable-global", extensionId),
    uninstallGlobal: (extensionId) => invoke("extensions:uninstall-global", extensionId),
    enableSite: (siteId, extensionId) => invoke("extensions:enable-site", siteId, extensionId),
    disableSite: (siteId, extensionId) => invoke("extensions:disable-site", siteId, extensionId),
    uninstallSite: (siteId, extensionId) => invoke("extensions:uninstall-site", siteId, extensionId),
  },
  jarvisScripts: {
    listGlobal: () => invoke<JarvisScript[]>("jarvis-scripts:list-global"),
    listSite: (siteId: string) => invoke<JarvisScript[]>("jarvis-scripts:list-site", siteId),
    installGlobal: () => invoke("jarvis-scripts:install-global"),
    installSite: (siteId) => invoke("jarvis-scripts:install-site", siteId),
    enableGlobal: (scriptId) => invoke("jarvis-scripts:enable-global", scriptId),
    disableGlobal: (scriptId) => invoke("jarvis-scripts:disable-global", scriptId),
    uninstallGlobal: (scriptId) => invoke("jarvis-scripts:uninstall-global", scriptId),
    enableSite: (siteId, scriptId) => invoke("jarvis-scripts:enable-site", siteId, scriptId),
    disableSite: (siteId, scriptId) => invoke("jarvis-scripts:disable-site", siteId, scriptId),
    uninstallSite: (siteId, scriptId) => invoke("jarvis-scripts:uninstall-site", siteId, scriptId),
  },
  downloads: {
    list: () => invoke<DownloadState[]>("downloads:list"),
    pause: (downloadId) => invoke("downloads:pause", downloadId),
    resume: (downloadId) => invoke("downloads:resume", downloadId),
    cancel: (downloadId) => invoke("downloads:cancel", downloadId),
    open: (downloadId) => invoke("downloads:open", downloadId),
    showInFolder: (downloadId) => invoke("downloads:show-in-folder", downloadId),
    remove: (downloadId) => invoke("downloads:remove", downloadId),
    clear: () => invoke("downloads:clear"),
  },
  settings: {
    get: () => invoke<DownloadSettings>("settings:get"),
    update: (input) => invoke("settings:update", input),
    selectDownloadPath: () => invoke("settings:select-download-path"),
  },
  windowChrome,
  onBrowserStateChanged: (callback) => on<[BrowserState]>("browser:state-changed", callback),
  onSiteMetadataUpdated: (callback) => on<[Site[]]>("site:metadata-updated", callback),
  onDownloadUpdated: (callback) => on<[DownloadState]>("download:updated", callback),
  onExtensionUpdated: (callback) => on<[string, SiteExtension[]]>("extension:updated", callback),
  onJarvisScriptUpdated: (callback) => on<[string | undefined, JarvisScript[]]>("jarvis-script:updated", callback),
  onJarvisScriptMessage: (callback) => on<[JarvisScriptMessage]>("jarvis-script:message", callback),
};

contextBridge.exposeInMainWorld("appApi", appApi);
