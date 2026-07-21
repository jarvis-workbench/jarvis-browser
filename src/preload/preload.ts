import { contextBridge, ipcRenderer } from "electron";
import type { AppApi, AppUpdateStatus, BrowserFindInPageResult, BrowserNavigationResult, BrowserRect, BrowserState, BrowserTab, CookieGetDetails, CookieInfo, CookieRemoveDetails, CookieSetDetails, DownloadSettings, DownloadState, HistoryRecord, JarvisScript, JarvisScriptMessage, OpenSessionSyncDialogInput, Site, SiteExtension, StorageClearDataResult, StoragePartitionStats, WindowChromeInfo } from "../shared/types";

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
    reorder: (siteIds) => invoke("sites:reorder", siteIds),
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
    createTab: (input) => invoke("browser:create-tab", input),
    createSiteTab: (input) => invoke("browser:create-site-tab", input),
    openInternalPage: (input) => invoke("browser:open-internal-page", input),
    listTabs: () => invoke("browser:list-tabs"),
    activateTab: (tabId) => invoke("browser:activate-tab", tabId),
    reorderTabs: (tabIds) => invoke("browser:reorder-tabs", tabIds),
    closeTab: (tabId) => invoke("browser:close-tab", tabId),
    navigateTab: (tabId, url) => invoke<BrowserNavigationResult>("browser:navigate-tab", tabId, url),
    navigate: (url) => invoke<BrowserNavigationResult>("browser:navigate", url),
    back: (tabId) => invoke("browser:back", tabId),
    forward: (tabId) => invoke("browser:forward", tabId),
    reload: (tabId) => invoke("browser:reload", tabId),
    stop: (tabId) => invoke("browser:stop", tabId),
    findInPage: (input) => invoke("browser:find-in-page", input),
    stopFindInPage: (action) => invoke("browser:stop-find-in-page", action),
    showHome: () => invoke("browser:show-home"),
    hideEmbeddedView: () => invoke("browser:hide-embedded-view"),
    showActiveView: () => invoke("browser:show-active-view"),
    setBounds: (rect: BrowserRect) => invoke("browser:set-bounds", rect),
    close: () => invoke("browser:close"),
    closeSession: (siteId, sessionId) => invoke("browser:close-session", siteId, sessionId),
    debugState: () => invoke("browser:debug-state"),
  },
  overlays: {
    openExtensionMenu: (input) => invoke("overlays:open-extension-menu", input),
    openDownloadsBubble: (input) => invoke("overlays:open-downloads-bubble", input),
    openAppMenu: (input) => invoke("overlays:open-app-menu", input),
    close: () => invoke("overlays:close"),
  },
  extensions: {
    listGlobal: () => invoke<SiteExtension[]>("extensions:list-global"),
    listSite: (siteId: string) => invoke<SiteExtension[]>("extensions:list-site", siteId),
    listPinned: () => invoke<string[]>("extensions:list-pinned"),
    setPinned: (extensionIds) => invoke<string[]>("extensions:set-pinned", extensionIds),
    togglePinned: (extensionId) => invoke<string[]>("extensions:toggle-pinned", extensionId),
    installGlobal: () => invoke("extensions:install-global"),
    installSite: (siteId) => invoke("extensions:install-site", siteId),
    enableGlobal: (extensionId) => invoke("extensions:enable-global", extensionId),
    disableGlobal: (extensionId) => invoke("extensions:disable-global", extensionId),
    uninstallGlobal: (extensionId) => invoke("extensions:uninstall-global", extensionId),
    enableSite: (siteId, extensionId) => invoke("extensions:enable-site", siteId, extensionId),
    disableSite: (siteId, extensionId) => invoke("extensions:disable-site", siteId, extensionId),
    uninstallSite: (siteId, extensionId) => invoke("extensions:uninstall-site", siteId, extensionId),
    openPopup: (input) => invoke("extensions:open-popup", input),
    closePopup: () => invoke("extensions:close-popup"),
  },
  extensionPopup: {
    cookiesGet: (details: CookieGetDetails) => invoke<CookieInfo[]>("extension-popup:cookies-get", details),
    cookiesSet: (details: CookieSetDetails) => invoke("extension-popup:cookies-set", details),
    cookiesRemove: (details: CookieRemoveDetails) => invoke("extension-popup:cookies-remove", details),
    createTab: (input) => invoke<BrowserTab>("extension-popup:create-tab", input),
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
  history: {
    list: (input) => invoke<HistoryRecord[]>("history:list", input),
    clear: (input) => invoke("history:clear", input),
  },
  storage: {
    stats: (input) => invoke<StoragePartitionStats[]>("storage:stats", input),
    clearData: (input) => invoke<StorageClearDataResult>("storage:clear-data", input),
  },
  sessionSync: {
    export: (input) => invoke("session-sync:export", input),
    previewImport: (input) => invoke("session-sync:preview-import", input),
    applyImport: (input) => invoke("session-sync:apply-import", input),
    cancelImport: (importId) => invoke("session-sync:cancel-import", importId),
  },
  settings: {
    get: () => invoke<DownloadSettings>("settings:get"),
    update: (input) => invoke("settings:update", input),
    selectDownloadPath: () => invoke("settings:select-download-path"),
    getAutomationBridge: () => invoke("settings:get-automation-bridge"),
    updateAutomationBridge: (input) => invoke("settings:update-automation-bridge", input),
    regenerateAutomationBridgeToken: () => invoke("settings:regenerate-automation-bridge-token"),
  },
  updates: {
    getStatus: () => invoke<AppUpdateStatus>("updates:get-status"),
    checkForUpdates: () => invoke<AppUpdateStatus>("updates:check-for-updates"),
    downloadUpdate: () => invoke<AppUpdateStatus>("updates:download-update"),
    quitAndInstall: () => invoke<AppUpdateStatus>("updates:quit-and-install"),
  },
  windowChrome,
  onBrowserStateChanged: (callback) => on<[BrowserState]>("browser:state-changed", callback),
  onBrowserTabsChanged: (callback) => on<[{ activeTabId?: string; tabs: BrowserTab[] }]>("browser:tabs-changed", callback),
  onOpenFindBar: (callback) => on<[]>("browser:open-find-bar", callback),
  onBrowserFindResult: (callback) => on<[BrowserFindInPageResult]>("browser:find-result", callback),
  onSiteMetadataUpdated: (callback) => on<[Site[]]>("site:metadata-updated", callback),
  onDownloadUpdated: (callback) => on<[DownloadState]>("download:updated", callback),
  onExtensionUpdated: (callback) => on<[string, SiteExtension[]]>("extension:updated", callback),
  onPinnedExtensionsChanged: (callback) => on<[string[]]>("extension:pinned-changed", callback),
  onJarvisScriptUpdated: (callback) => on<[string | undefined, JarvisScript[]]>("jarvis-script:updated", callback),
  onJarvisScriptMessage: (callback) => on<[JarvisScriptMessage]>("jarvis-script:message", callback),
  onOpenSessionSyncDialog: (callback) => on<[OpenSessionSyncDialogInput]>("session-sync:open-dialog", callback),
  onUpdateStatusChanged: (callback) => on<[AppUpdateStatus]>("updates:status-changed", callback),
};

contextBridge.exposeInMainWorld("appApi", appApi);
