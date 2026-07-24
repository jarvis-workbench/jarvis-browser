export interface BrowserRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CookieSetDetails {
  url: string;
  name: string;
  value: string;
  siteId?: string;
  sessionId?: string;
  domain?: string;
  path?: string;
  secure?: boolean;
  httpOnly?: boolean;
  expirationDate?: number;
  sameSite?: "unspecified" | "no_restriction" | "lax" | "strict";
}

export interface CookieRemoveDetails {
  url: string;
  name: string;
  siteId?: string;
  sessionId?: string;
}

export interface CookieGetDetails {
  url?: string;
  name?: string;
  domain?: string;
  path?: string;
  secure?: boolean;
  session?: boolean;
  siteId?: string;
  sessionId?: string;
}

export interface CookieInfo {
  name: string;
  value: string;
  domain?: string;
  hostOnly?: boolean;
  path?: string;
  secure?: boolean;
  httpOnly?: boolean;
  session?: boolean;
  expirationDate?: number;
  sameSite?: "unspecified" | "no_restriction" | "lax" | "strict";
}

export interface SiteSession {
  id: string;
  siteId?: string;
  name: string;
  lastUrl: string;
  url?: string;
  createdAt: string;
  updatedAt: string;
}

export interface SiteExtension {
  id: string;
  name: string;
  version: string;
  path: string;
  enabled: boolean;
  permissions: string[];
  action?: SiteExtensionAction;
  icon?: string;
  loadError?: string;
  createdAt: string;
  updatedAt: string;
}

export interface SiteExtensionAction {
  defaultPopup: string;
  defaultTitle?: string;
  icon?: string;
  popupWidth?: number;
  popupHeight?: number;
}

export type JarvisScriptScope = "global" | "site";

export interface JarvisMonitorDeclaration {
  id: string;
  name?: string;
  matches?: string[];
  events?: string[];
}

export interface JarvisWorkerDeclaration {
  id: string;
  entry: string;
}

export interface JarvisContentScriptDeclaration {
  id: string;
  matches?: string[];
  js?: string[];
  css?: string[];
}

export interface JarvisScriptManifest {
  id?: string;
  name: string;
  version?: string;
  description?: string;
  enabled?: boolean;
  permissions?: string[];
  monitors?: JarvisMonitorDeclaration[];
  workers?: JarvisWorkerDeclaration[];
  contentScripts?: JarvisContentScriptDeclaration[];
}

export interface JarvisScriptRuntimeState {
  enabled: boolean;
  loadError?: string;
  lastStartedAt?: string;
  lastStoppedAt?: string;
}

export interface JarvisScriptMessage {
  scriptId: string;
  scope: JarvisScriptScope;
  siteId?: string;
  channel: string;
  payload: unknown;
}

export interface JarvisScript {
  id: string;
  name: string;
  version: string;
  description?: string;
  scope: JarvisScriptScope;
  siteId?: string;
  path: string;
  manifest: JarvisScriptManifest;
  runtimeState: JarvisScriptRuntimeState;
  createdAt: string;
  updatedAt: string;
}

export interface Site {
  id: string;
  title: string;
  name?: string;
  url: string;
  faviconUrl?: string;
  faviconPath?: string;
  sessions: SiteSession[];
  extensions: SiteExtension[];
  jarvisScripts: JarvisScript[];
  createdAt: string;
  updatedAt: string;
}

export interface BrowserState {
  tabId?: string;
  kind?: BrowserTabKind;
  siteId?: string;
  sessionId?: string;
  partition?: string;
  url: string;
  displayUrl?: string;
  title: string;
  favicon?: string;
  canGoBack: boolean;
  canGoForward: boolean;
  isLoading: boolean;
  errorText?: string;
}

export type BrowserTabKind = "internal" | "site" | "default";

export type BrowserInternalPageId =
  | "newtab"
  | "downloads"
  | "settings"
  | "extensions"
  | "jarvis-script"
  | "history"
  | "clear-browsing-data";

export interface BrowserTab {
  id: string;
  kind: BrowserTabKind;
  url: string;
  title: string;
  favicon?: string;
  siteId?: string;
  sessionId?: string;
  partition: string;
  parentTabId?: string;
  openerTabId?: string;
  internalPageId?: BrowserInternalPageId;
  pinnedExtensionIds: string[];
  createdAt: string;
  updatedAt: string;
}

export interface CreateBrowserTabInput {
  url?: string;
  openerTabId?: string;
}

export interface CreateSiteTabInput {
  siteId: string;
  sessionId: string;
}

export interface OpenInternalPageInput {
  pageId: BrowserInternalPageId;
  /** When opening extensions from a site session, select that site in the manager. */
  siteId?: string;
}

export type BrowserNavigationResult =
  | {
    kind: "loaded";
    url: string;
  }
  | {
    kind: "external-opened";
    url: string;
  }
  | {
    kind: "blocked";
    url: string;
    errorText: string;
  };

export interface BrowserFindInPageInput {
  text: string;
  forward?: boolean;
  findNext?: boolean;
  matchCase?: boolean;
}

export interface BrowserFindInPageRequest {
  tabId: string;
  requestId: number;
  query: string;
}

export interface BrowserFindInPageResult {
  tabId: string;
  requestId: number;
  query: string;
  activeMatchOrdinal: number;
  matches: number;
  finalUpdate: boolean;
}

export interface TabState extends BrowserState {
  tabId: string;
}

export interface DownloadState {
  id: string;
  filename: string;
  url: string;
  savePath: string;
  mimeType: string;
  receivedBytes: number;
  totalBytes: number;
  state: 'queued' | 'progressing' | 'completed' | 'cancelled' | 'interrupted';
  startTime: number;
  endTime?: number;
  paused: boolean;
  canResume: boolean;
  speedBytesPerSecond: number;
  errorText?: string;
}

export interface DownloadSettings {
  downloadPath: string;
  askWhereToSaveBeforeDownloading: boolean;
}

export interface AutomationBridgeSettings {
  enabled: boolean;
  port: number;
  token: string;
}

export interface AutomationBridgeStatus extends AutomationBridgeSettings {
  running: boolean;
  origin: string;
  lastError?: string;
}

export interface AutomationTabInfo extends BrowserTab {
  currentUrl: string;
  displayUrl?: string;
  isLoading: boolean;
  webContentsId?: number;
}

export interface AutomationEvaluateInput {
  tabId?: string;
  code: string;
  args?: unknown;
  timeoutMs?: number;
}

export interface AutomationEvaluateResult {
  ok: boolean;
  tab: AutomationTabInfo;
  value?: unknown;
  error?: {
    name?: string;
    message: string;
    stack?: string;
  };
}

export interface AutomationDomElement {
  tagName: string;
  id: string;
  className: string;
  text: string;
  selector: string;
  attributes: Record<string, string>;
  rect: BrowserRect;
  visible: boolean;
  html?: string;
  children?: AutomationDomElement[];
}

export interface AutomationDomQueryInput {
  tabId?: string;
  selector: string;
  limit?: number;
  includeHtml?: boolean;
  textMaxLength?: number;
}

export interface AutomationDomQueryResult {
  tab: AutomationTabInfo;
  pageUrl: string;
  title: string;
  elements: AutomationDomElement[];
}

export interface AutomationDomSnapshotInput {
  tabId?: string;
  selector?: string;
  maxDepth?: number;
  maxChildren?: number;
  textMaxLength?: number;
}

export interface AutomationDomSnapshotResult {
  tab: AutomationTabInfo;
  pageUrl: string;
  title: string;
  roots: AutomationDomElement[];
}

export interface AutomationTelegramInput {
  tabId?: string;
  action?: "scan" | "debug" | "download";
  ids?: string[];
  timeoutMs?: number;
}

export interface AutomationTelegramResult {
  tab: AutomationTabInfo;
  ok: boolean;
  result?: unknown;
  error?: string;
}

export type AppUpdatePhase =
  | "idle"
  | "unsupported"
  | "checking"
  | "available"
  | "not-available"
  | "downloading"
  | "downloaded"
  | "installing"
  | "error";

export interface AppUpdateProgress {
  percent: number;
  transferred: number;
  total: number;
  bytesPerSecond: number;
}

export interface AppUpdateStatus {
  phase: AppUpdatePhase;
  currentVersion: string;
  availableVersion?: string;
  releaseDate?: string;
  releaseName?: string;
  releaseNotes?: string;
  progress?: AppUpdateProgress;
  errorText?: string;
  isPackaged: boolean;
  platform: string;
  updatedAt: string;
}

export interface HistoryRecord {
  id: string;
  tabId?: string;
  siteId?: string;
  sessionId?: string;
  partition: string;
  origin: string;
  url: string;
  title?: string;
  visitedAt: string;
  createdAt: string;
}

export interface HistoryListInput {
  partition?: string;
  origin?: string;
  siteId?: string;
  sessionId?: string;
  limit?: number;
}

export interface HistoryClearInput {
  partition?: string;
  origin?: string;
  siteId?: string;
  sessionId?: string;
}

export interface StorageStatsInput {
  partition?: string;
}

export interface StoragePartitionStats {
  partition: string;
  cacheBytes: number;
  httpCacheBytes: number;
  serviceWorkerCacheBytes: number;
  storagePath?: string;
}

export interface StorageClearDataInput {
  partition: string;
}

export interface StorageClearDataResult {
  partition: string;
  cacheCleared: boolean;
  serviceWorkerCacheCleared: boolean;
}

export type SessionSyncScope = "global" | "site";

export type SessionSyncConflictAction = "skip" | "overwrite" | "overwrite-all";

export type SessionSyncConflictKind = "none" | "site-host" | "session-name";

export interface SessionSyncSelection {
  siteId: string;
  sessionId: string;
}

export interface OpenSessionSyncDialogInput {
  scope: SessionSyncScope;
  siteId?: string;
  hideActiveView?: boolean;
}

export interface SessionSyncExportInput {
  scope?: SessionSyncScope;
  siteId?: string;
  siteIds?: string[];
  sessionIds?: string[];
  sessions?: SessionSyncSelection[];
  encrypted: boolean;
  password?: string;
}

export interface SessionSyncExportResult {
  canceled: boolean;
  filePath?: string;
  exportedSites: number;
  exportedSessions: number;
  exportedSiteCount?: number;
  exportedSessionCount?: number;
}

export interface SessionSyncPreviewImportInput {
  scope: SessionSyncScope;
  siteId?: string;
  password?: string;
}

export interface SessionSyncPreviewSession {
  id: string;
  sourceSiteId: string;
  sourceSessionId: string;
  name: string;
  siteId?: string;
  lastUrl: string;
  duplicate?: boolean;
  existingSessionId?: string;
  targetSiteId?: string;
  targetSessionId?: string;
  conflict: SessionSyncConflictKind;
  hasPartition: boolean;
  hasWebState: boolean;
  importable: boolean;
  skippedReason?: string;
}

export interface SessionSyncPreviewSite {
  id: string;
  sourceSiteId: string;
  title: string;
  url: string;
  host: string;
  duplicate?: boolean;
  existingSiteId?: string;
  targetSiteId?: string;
  conflict: SessionSyncConflictKind;
  importable: boolean;
  skippedReason?: string;
  sessions: SessionSyncPreviewSession[];
}

export interface SessionSyncPreviewImportResult {
  canceled: boolean;
  importId?: string;
  filePath?: string;
  fileName?: string;
  encrypted: boolean;
  sites: SessionSyncPreviewSite[];
  duplicateSiteCount: number;
  duplicateSessionCount: number;
  summary: {
    totalSites: number;
    importableSites: number;
    totalSessions: number;
    importableSessions: number;
  };
}

export interface SessionSyncApplyImportInput {
  importId: string;
  scope?: SessionSyncScope;
  siteId?: string;
  siteConflictAction?: SessionSyncConflictAction;
  sessionConflictAction?: SessionSyncConflictAction;
  siteConflicts?: Record<string, SessionSyncConflictAction>;
  sessionConflicts?: Record<string, SessionSyncConflictAction>;
}

export interface SessionSyncApplyImportResult {
  importedSites: number;
  updatedSites: number;
  importedSessions: number;
  overwrittenSessions: number;
  skippedSessions: Array<{
    sourceSiteId: string;
    sourceSessionId: string;
    reason: string;
  }>;
  unsupportedSessions: Array<{
    sourceSiteId: string;
    sourceSessionId: string;
    reason: string;
  }>;
  importedSiteCount?: number;
  importedSessionCount?: number;
  skippedSiteCount?: number;
  skippedSessionCount?: number;
}

export interface BrowserDebugState {
  activeTabId?: string;
  viewCount: number;
  viewKeys: string[];
}

export interface WindowChromeInfo {
  platform: 'darwin' | 'win32' | 'linux' | string;
  isMac: boolean;
  isWindows: boolean;
  titlebarHeight: number;
  titlebarLeftInset: number;
  titlebarRightInset: number;
  capsuleWidth: number;
  capsuleGap: number;
}

export interface AppApi {
  sites: {
    list(): Promise<Site[]>;
    add(input: { url: string; title?: string }): Promise<Site>;
    update(siteId: string, input: { url?: string; title?: string }): Promise<Site>;
    reorder(siteIds: string[]): Promise<Site[]>;
    delete(siteId: string): Promise<void>;
  };
  sessions: {
    add(siteId: string, input: { name: string }): Promise<SiteSession>;
    rename(siteId: string, sessionId: string, name: string): Promise<SiteSession>;
    delete(siteId: string, sessionId: string): Promise<void>;
    clearData(siteId: string, sessionId: string, options: { cookies: boolean; cache: boolean; storage: boolean }): Promise<void>;
  };
  browser: {
    open(siteId: string, sessionId: string): Promise<void>;
    createTab(input?: CreateBrowserTabInput): Promise<BrowserTab>;
    createSiteTab(input: CreateSiteTabInput): Promise<BrowserTab>;
    openInternalPage(input: OpenInternalPageInput): Promise<BrowserTab>;
    listTabs(): Promise<{ activeTabId?: string; tabs: BrowserTab[] }>;
    activateTab(tabId: string): Promise<void>;
    reorderTabs(tabIds: string[]): Promise<void>;
    closeTab(tabId: string): Promise<void>;
    navigateTab(tabId: string, url: string): Promise<BrowserNavigationResult>;
    navigate(url: string): Promise<BrowserNavigationResult>;
    back(tabId?: string): Promise<void>;
    forward(tabId?: string): Promise<void>;
    reload(tabId?: string): Promise<void>;
    stop(tabId?: string): Promise<void>;
    findInPage(input: BrowserFindInPageInput): Promise<BrowserFindInPageRequest | undefined>;
    stopFindInPage(action?: 'clearSelection' | 'keepSelection' | 'activateSelection'): Promise<void>;
    showHome(): Promise<void>;
    hideEmbeddedView(): Promise<void>;
    showActiveView(): Promise<void>;
    setBounds(rect: BrowserRect): Promise<void>;
    close(): Promise<void>;
    closeSession(siteId: string, sessionId: string): Promise<void>;
    debugState(): Promise<BrowserDebugState>;
  };
  overlays: {
    openExtensionMenu(input: { anchor: BrowserRect }): Promise<void>;
    openDownloadsBubble(input: { anchor: BrowserRect }): Promise<void>;
    openAppMenu(input: { anchor: BrowserRect }): Promise<void>;
    close(): Promise<void>;
  };
  extensions: {
    listGlobal(): Promise<SiteExtension[]>;
    listSite(siteId: string): Promise<SiteExtension[]>;
    listPinned(): Promise<string[]>;
    setPinned(extensionIds: string[]): Promise<string[]>;
    togglePinned(extensionId: string): Promise<string[]>;
    installGlobal(): Promise<SiteExtension | undefined>;
    installSite(siteId: string): Promise<SiteExtension | undefined>;
    enableGlobal(extensionId: string): Promise<SiteExtension>;
    disableGlobal(extensionId: string): Promise<SiteExtension>;
    uninstallGlobal(extensionId: string): Promise<void>;
    enableSite(siteId: string, extensionId: string): Promise<SiteExtension>;
    disableSite(siteId: string, extensionId: string): Promise<SiteExtension>;
    uninstallSite(siteId: string, extensionId: string): Promise<void>;
    openPopup(input: { siteId: string; sessionId: string; extensionId: string; anchor: BrowserRect }): Promise<void>;
    closePopup(): Promise<void>;
  };
  extensionPopup: {
    cookiesGet(details: CookieGetDetails): Promise<CookieInfo[]>;
    cookiesSet(details: CookieSetDetails): Promise<void>;
    cookiesRemove(details: CookieRemoveDetails): Promise<void>;
    createTab(input: { url: string; openerTabId?: string; siteId?: string; sessionId?: string }): Promise<BrowserTab>;
  };
  jarvisScripts: {
    listGlobal(): Promise<JarvisScript[]>;
    listSite(siteId: string): Promise<JarvisScript[]>;
    installGlobal(): Promise<JarvisScript | undefined>;
    installSite(siteId: string): Promise<JarvisScript | undefined>;
    enableGlobal(scriptId: string): Promise<JarvisScript>;
    disableGlobal(scriptId: string): Promise<JarvisScript>;
    uninstallGlobal(scriptId: string): Promise<void>;
    enableSite(siteId: string, scriptId: string): Promise<JarvisScript>;
    disableSite(siteId: string, scriptId: string): Promise<JarvisScript>;
    uninstallSite(siteId: string, scriptId: string): Promise<void>;
  };
  downloads: {
    list(): Promise<DownloadState[]>;
    pause(downloadId: string): Promise<DownloadState>;
    resume(downloadId: string): Promise<DownloadState>;
    cancel(downloadId: string): Promise<DownloadState>;
    open(downloadId: string): Promise<void>;
    showInFolder(downloadId: string): Promise<void>;
    remove(downloadId: string): Promise<void>;
    clear(): Promise<void>;
  };
  history: {
    list(input?: HistoryListInput): Promise<HistoryRecord[]>;
    clear(input?: HistoryClearInput): Promise<void>;
  };
  storage: {
    stats(input?: StorageStatsInput): Promise<StoragePartitionStats[]>;
    clearData(input: StorageClearDataInput): Promise<StorageClearDataResult>;
  };
  sessionSync: {
    export(input: SessionSyncExportInput): Promise<SessionSyncExportResult>;
    previewImport(input: SessionSyncPreviewImportInput): Promise<SessionSyncPreviewImportResult>;
    applyImport(input: SessionSyncApplyImportInput): Promise<SessionSyncApplyImportResult>;
    cancelImport(importId: string): Promise<void>;
  };
  settings: {
    get(): Promise<DownloadSettings>;
    update(input: Partial<DownloadSettings>): Promise<DownloadSettings>;
    selectDownloadPath(): Promise<string | undefined>;
    getAutomationBridge(): Promise<AutomationBridgeStatus>;
    updateAutomationBridge(input: Partial<Pick<AutomationBridgeSettings, "enabled" | "port">>): Promise<AutomationBridgeStatus>;
    regenerateAutomationBridgeToken(): Promise<AutomationBridgeStatus>;
  };
  updates: {
    getStatus(): Promise<AppUpdateStatus>;
    checkForUpdates(): Promise<AppUpdateStatus>;
    downloadUpdate(): Promise<AppUpdateStatus>;
    quitAndInstall(): Promise<AppUpdateStatus>;
  };
  windowChrome: WindowChromeInfo;
  onBrowserStateChanged(callback: (state: BrowserState) => void): () => void;
  onBrowserTabsChanged(callback: (state: { activeTabId?: string; tabs: BrowserTab[] }) => void): () => void;
  onOpenFindBar(callback: () => void): () => void;
  onBrowserFindResult(callback: (result: BrowserFindInPageResult) => void): () => void;
  onSiteMetadataUpdated(callback: (sites: Site[]) => void): () => void;
  onDownloadUpdated(callback: (download: DownloadState) => void): () => void;
  onExtensionUpdated(callback: (siteId: string, extensions: SiteExtension[]) => void): () => void;
  onPinnedExtensionsChanged(callback: (extensionIds: string[]) => void): () => void;
  onJarvisScriptUpdated(callback: (siteId: string | undefined, scripts: JarvisScript[]) => void): () => void;
  onJarvisScriptMessage(callback: (message: JarvisScriptMessage) => void): () => void;
  onOpenSessionSyncDialog(callback: (input: OpenSessionSyncDialogInput) => void): () => void;
  onUpdateStatusChanged(callback: (status: AppUpdateStatus) => void): () => void;
}
