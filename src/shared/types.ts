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
  siteId?: string;
  sessionId?: string;
  url: string;
  displayUrl?: string;
  title: string;
  canGoBack: boolean;
  canGoForward: boolean;
  isLoading: boolean;
  errorText?: string;
}

export interface DownloadState {
  id: string;
  filename: string;
  url: string;
  savePath: string;
  mimeType: string;
  receivedBytes: number;
  totalBytes: number;
  state: 'progressing' | 'completed' | 'cancelled' | 'interrupted';
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

export interface BrowserDebugState {
  activeSiteId?: string;
  activeSessionId?: string;
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
    navigate(url: string): Promise<void>;
    back(): Promise<void>;
    forward(): Promise<void>;
    reload(): Promise<void>;
    stop(): Promise<void>;
    showHome(): Promise<void>;
    hideEmbeddedView(): Promise<void>;
    showActiveView(): Promise<void>;
    setBounds(rect: BrowserRect): Promise<void>;
    close(): Promise<void>;
    closeSession(siteId: string, sessionId: string): Promise<void>;
    debugState(): Promise<BrowserDebugState>;
  };
  extensions: {
    listGlobal(): Promise<SiteExtension[]>;
    listSite(siteId: string): Promise<SiteExtension[]>;
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
    cookiesSet(details: CookieSetDetails): Promise<void>;
    cookiesRemove(details: CookieRemoveDetails): Promise<void>;
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
  settings: {
    get(): Promise<DownloadSettings>;
    update(input: Partial<DownloadSettings>): Promise<DownloadSettings>;
    selectDownloadPath(): Promise<string | undefined>;
  };
  windowChrome: WindowChromeInfo;
  onBrowserStateChanged(callback: (state: BrowserState) => void): () => void;
  onSiteMetadataUpdated(callback: (sites: Site[]) => void): () => void;
  onDownloadUpdated(callback: (download: DownloadState) => void): () => void;
  onExtensionUpdated(callback: (siteId: string, extensions: SiteExtension[]) => void): () => void;
  onJarvisScriptUpdated(callback: (siteId: string | undefined, scripts: JarvisScript[]) => void): () => void;
  onJarvisScriptMessage(callback: (message: JarvisScriptMessage) => void): () => void;
}
