import {
  BrowserWindow,
  WebContentsView,
} from "electron";
import { join } from "node:path";
import type { BrowserRect, BrowserState } from "../../shared/types";
import { clampBrowserBounds, defaultBrowserBounds } from "../browser-bounds";
import { DownloadManager } from "../download-manager";
import { createErrorPageUrl, isInternalErrorPageUrl, registerErrorPageProtocolForSession } from "../error-page";
import { flushElectronSession, getElectronSession } from "../electron-session-manager";
import { ExtensionRuntime } from "../extension-runtime";
import { JarvisScriptManager } from "../jarvis-script/manager";
import { JarvisScriptRuntime } from "../jarvis-script/runtime";
import { MetadataStore, normalizeHttpUrl } from "../store";
import { createViewKey, parseViewKey } from "./keys";
import { ViewLifecycle } from "./lifecycle";
import { JarvisMonitorController } from "./monitor/controller";
import { formatNavigationError, isBrowserDevToolsShortcut, isBrowserReloadShortcut, isNavigationAbort } from "./navigation";
import { createBrowserState, fallbackBrowserState } from "./state";
import { ViewRegistry } from "./view-registry";

export class BrowserHost {
  private readonly views = new Map<string, WebContentsView>();
  private readonly viewStates = new Map<string, BrowserState>();
  private readonly lifecycle = new ViewLifecycle();
  private readonly failedNavigationUrls = new Map<string, string>();
  private readonly failedNavigationStatusCodes = new Map<string, number>();
  private readonly responseStatusCodes = new Map<string, number>();
  private openRequestSeq = 0;
  private siteId?: string;
  private sessionId?: string;
  private bounds = defaultBrowserBounds;
  private readonly downloadManager: DownloadManager;
  private readonly extensionRuntime: ExtensionRuntime;
  private readonly jarvisScriptRuntime: JarvisScriptRuntime;
  private readonly jarvisScriptManager: JarvisScriptManager;
  private readonly viewRegistry: ViewRegistry;

  constructor(
    private readonly window: BrowserWindow,
    private readonly store: MetadataStore,
  ) {
    this.viewRegistry = new ViewRegistry(window, this.views, () => this.bounds);
    this.downloadManager = new DownloadManager(window, store);
    this.extensionRuntime = new ExtensionRuntime(window, store, (key, targetSession) => {
      this.downloadManager.bindSession(key, targetSession);
    });
    this.jarvisScriptRuntime = new JarvisScriptRuntime({
      window,
      store,
      emitMetadataUpdate: () => this.emitMetadataUpdate(),
      emitBrowserState: (viewKey, errorText) => this.emitBrowserState(viewKey, errorText),
      isPageSuccessful: (viewKey, pageUrl) => this.isPageSuccessful(viewKey, pageUrl),
      sendMessageToWebContents: (input) => this.sendJarvisScriptMessageToWebContents(input),
    });
    this.jarvisScriptManager = new JarvisScriptManager(window, store, this.jarvisScriptRuntime);
  }

  async open(siteId: string, sessionId: string) {
    const openRequestId = ++this.openRequestSeq;
    const site = this.store.getSite(siteId);
    const siteSession = this.store.getSession(siteId, sessionId);
    if (!site || !siteSession) {
      throw new Error("会话不存在");
    }

    this.siteId = siteId;
    this.sessionId = sessionId;
    const viewKey = createViewKey(siteId, sessionId);
    let view = this.views.get(viewKey);

    if (!view) {
      const targetSession = getElectronSession(siteId, sessionId);
      registerErrorPageProtocolForSession(targetSession);
      this.downloadManager.bindSession(viewKey, targetSession);

      view = new WebContentsView({
        webPreferences: {
          session: targetSession,
          preload: join(__dirname, "../../preload/error-page-preload.js"),
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
        },
      });

      this.views.set(viewKey, view);
      this.lifecycle.markOpen(viewKey);
      this.bindNavigationEvents(view, siteId, sessionId);
      this.bindMonitor(view, siteId, sessionId, viewKey);
      this.updateViewState(viewKey, view, { siteId, sessionId, url: site.url });
      this.activateViewIfCurrent(viewKey);
      await this.extensionRuntime.loadEnabledForSite(site);
      await this.jarvisScriptRuntime.refreshUserScriptWorkers();
      await this.loadUrlSafely(normalizeHttpUrl(site.url), view, viewKey);
    }

    if (this.isLatestOpenForCurrentView(openRequestId, viewKey)) {
      this.activateViewIfCurrent(viewKey);
      this.emitBrowserState(viewKey);
    }
  }

  async navigate(url: string) {
    const active = this.requireActiveSession();
    const nextUrl = normalizeHttpUrl(url);
    const viewKey = createViewKey(active.siteId, active.sessionId);
    await this.loadUrlSafely(nextUrl, this.getActiveView(), viewKey);
  }

  back() {
    this.requireActiveSession();
    const view = this.getActiveView();
    if (view.webContents.navigationHistory.canGoBack()) {
      view.webContents.navigationHistory.goBack();
    }
  }

  forward() {
    this.requireActiveSession();
    const view = this.getActiveView();
    if (view.webContents.navigationHistory.canGoForward()) {
      view.webContents.navigationHistory.goForward();
    }
  }

  reload() {
    this.requireActiveSession();
    this.getActiveView().webContents.reload();
  }

  openDevTools() {
    this.requireActiveSession();
    this.getActiveView().webContents.openDevTools({ mode: "detach" });
  }

  async reloadErrorPage() {
    const active = this.requireActiveSession();
    const viewKey = createViewKey(active.siteId, active.sessionId);
    const targetUrl = this.failedNavigationUrls.get(viewKey);
    if (!targetUrl) {
      this.reload();
      return;
    }

    this.failedNavigationStatusCodes.delete(viewKey);
    this.responseStatusCodes.delete(viewKey);
    await this.loadUrlSafely(targetUrl, this.getActiveView(), viewKey);
  }

  private async showHttpErrorPage(siteId: string, sessionId: string, url: string, statusCode: number) {
    const viewKey = createViewKey(siteId, sessionId);
    const view = this.views.get(viewKey);
    if (!view || view.webContents.isDestroyed()) {
      return;
    }

    this.failedNavigationUrls.set(viewKey, url);
    this.failedNavigationStatusCodes.set(viewKey, statusCode);
    this.responseStatusCodes.delete(viewKey);
    await view.webContents.loadURL(createErrorPageUrl({
      kind: "http",
      url,
      statusCode,
      errorText: `请求失败，状态码：${statusCode}`,
    }));
    this.emitBrowserState(viewKey, `HTTP ${statusCode}`);
  }

  private async handleHttpStatusPage(viewKey: string, url: string, statusCode: number) {
    if (isInternalErrorPageUrl(url) || statusCode < 400) {
      return;
    }

    const view = this.views.get(viewKey);
    if (!view || view.webContents.isDestroyed()) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 400));
    if (!this.views.has(viewKey) || view.webContents.isDestroyed()) {
      return;
    }

    const bodyText = await view.webContents.executeJavaScript(
      "document.body ? document.body.innerText.trim() : ''",
      true,
    ).catch(() => "");
    if (bodyText) {
      this.emitBrowserState(viewKey, `HTTP ${statusCode}`);
      return;
    }

    const ids = parseViewKey(viewKey);
    await this.showHttpErrorPage(ids.siteId, ids.sessionId, url, statusCode);
  }

  stop() {
    this.requireActiveSession();
    this.getActiveView().webContents.stop();
  }

  showHome() {
    this.siteId = undefined;
    this.sessionId = undefined;
    this.unmountActiveView();
    this.emitHomeState();
  }

  hideEmbeddedView() {
    this.unmountActiveView();
  }

  showActiveView() {
    if (this.siteId && this.sessionId) {
      this.activateView(this.siteId, this.sessionId);
    }
  }

  setBounds(rect: BrowserRect) {
    this.bounds = clampBrowserBounds(rect);
    this.getActiveViewOrUndefined()?.setBounds(this.bounds);
  }

  async close() {
    for (const [viewKey, view] of this.views) {
      await this.flushViewSession(view);
      this.destroyView(viewKey, view);
    }
    this.views.clear();
    this.viewStates.clear();
    this.lifecycle.clear();
    this.failedNavigationUrls.clear();
    this.failedNavigationStatusCodes.clear();
    this.responseStatusCodes.clear();
    this.siteId = undefined;
    this.sessionId = undefined;
    this.viewRegistry.setMountedViewKey(undefined);
    this.jarvisScriptRuntime.close();
  }

  async closeSession(siteId: string, sessionId: string) {
    const viewKey = createViewKey(siteId, sessionId);
    const view = this.views.get(viewKey);
    if (view) {
      await this.flushViewSession(view);
      this.destroyView(viewKey, view);
      this.views.delete(viewKey);
    }
    this.viewStates.delete(viewKey);
    this.failedNavigationUrls.delete(viewKey);
    this.failedNavigationStatusCodes.delete(viewKey);
    this.responseStatusCodes.delete(viewKey);
    if (this.siteId === siteId && this.sessionId === sessionId) {
      this.siteId = undefined;
      this.sessionId = undefined;
      this.viewRegistry.setMountedViewKey(undefined);
    }
  }

  getActiveSiteId() {
    return this.siteId;
  }

  isActiveSession(siteId: string, sessionId: string) {
    return this.siteId === siteId && this.sessionId === sessionId;
  }

  getDebugState() {
    return {
      activeSiteId: this.siteId,
      activeSessionId: this.sessionId,
      viewCount: this.views.size,
      viewKeys: [...this.views.keys()],
    };
  }

  async installGlobalUnpacked() {
    return this.extensionRuntime.installGlobalUnpacked();
  }

  async installSiteUnpacked(siteId: string) {
    return this.extensionRuntime.installSiteUnpacked(siteId);
  }

  async enableGlobalExtension(extensionId: string) {
    return this.extensionRuntime.enableGlobal(extensionId);
  }

  async disableGlobalExtension(extensionId: string) {
    return this.extensionRuntime.disableGlobal(extensionId);
  }

  async uninstallGlobalExtension(extensionId: string) {
    await this.extensionRuntime.uninstallGlobal(extensionId);
  }

  async enableSiteExtension(siteId: string, extensionId: string) {
    return this.extensionRuntime.enableSite(siteId, extensionId);
  }

  async disableSiteExtension(siteId: string, extensionId: string) {
    return this.extensionRuntime.disableSite(siteId, extensionId);
  }

  async uninstallSiteExtension(siteId: string, extensionId: string) {
    await this.extensionRuntime.uninstallSite(siteId, extensionId);
  }

  listGlobalJarvisScripts() {
    return this.jarvisScriptRuntime.listGlobalRuntimeStates();
  }

  listSiteJarvisScripts(siteId: string) {
    return this.jarvisScriptRuntime.listSiteRuntimeStates(siteId);
  }

  async installGlobalJarvisScript() {
    return this.jarvisScriptManager.installGlobal();
  }

  async installSiteJarvisScript(siteId: string) {
    return this.jarvisScriptManager.installSite(siteId);
  }

  async enableGlobalJarvisScript(scriptId: string) {
    return this.jarvisScriptManager.enableGlobal(scriptId);
  }

  async disableGlobalJarvisScript(scriptId: string) {
    return this.jarvisScriptManager.disableGlobal(scriptId);
  }

  async uninstallGlobalJarvisScript(scriptId: string) {
    await this.jarvisScriptManager.uninstallGlobal(scriptId);
  }

  async enableSiteJarvisScript(siteId: string, scriptId: string) {
    return this.jarvisScriptManager.enableSite(siteId, scriptId);
  }

  async disableSiteJarvisScript(siteId: string, scriptId: string) {
    return this.jarvisScriptManager.disableSite(siteId, scriptId);
  }

  async uninstallSiteJarvisScript(siteId: string, scriptId: string) {
    await this.jarvisScriptManager.uninstallSite(siteId, scriptId);
  }

  bindDefaultDownloads() {
    this.downloadManager.bindDefault();
  }

  pauseDownload(downloadId: string) {
    return this.downloadManager.pause(downloadId);
  }

  resumeDownload(downloadId: string) {
    return this.downloadManager.resume(downloadId);
  }

  cancelDownload(downloadId: string) {
    return this.downloadManager.cancel(downloadId);
  }

  openDownload(downloadId: string) {
    return this.downloadManager.open(downloadId);
  }

  showDownloadInFolder(downloadId: string) {
    return this.downloadManager.showInFolder(downloadId);
  }

  private requireActiveSession() {
    if (!this.siteId || !this.sessionId || !this.getActiveViewOrUndefined()) {
      throw new Error("浏览器会话未打开");
    }

    return { siteId: this.siteId, sessionId: this.sessionId };
  }

  private bindNavigationEvents(view: WebContentsView, siteId: string, sessionId: string) {
    const webContents = view.webContents;
    const viewKey = createViewKey(siteId, sessionId);
    webContents.session.webRequest.onCompleted({ urls: ["http://*/*", "https://*/*"] }, (details) => {
      if (!this.isViewAlive(viewKey, webContents)) {
        return;
      }

      if (details.webContentsId === webContents.id && details.resourceType === "mainFrame" && details.statusCode >= 400) {
        this.responseStatusCodes.set(viewKey, details.statusCode);
        void this.handleHttpStatusPage(viewKey, details.url, details.statusCode);
      }
    });
    webContents.setWindowOpenHandler(({ url }) => {
      if (!this.isViewAlive(viewKey, webContents)) {
        return { action: "deny" };
      }

      void this.loadUrlSafely(normalizeHttpUrl(url), view, viewKey);
      return { action: "deny" };
    });
    webContents.on("did-start-loading", () => {
      if (this.isViewAlive(viewKey, webContents)) {
        this.emitBrowserState(viewKey);
      }
    });
    webContents.on("did-finish-load", () => {
      if (this.isViewAlive(viewKey, webContents)) {
        this.emitBrowserState(viewKey);
      }
    });
    webContents.on("did-stop-loading", () => {
      if (this.isViewAlive(viewKey, webContents)) {
        this.emitBrowserState(viewKey);
      }
    });
    webContents.on("before-input-event", (event, input) => {
      if (!this.isViewAlive(viewKey, webContents)) {
        return;
      }

      if (this.handleBrowserShortcut(input)) {
        event.preventDefault();
      }
    });
    webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedUrl, isMainFrame) => {
      if (!this.isViewAlive(viewKey, webContents)) {
        return;
      }

      if (isMainFrame && errorCode !== -3) {
        void this.loadMainFrameErrorPage(viewKey, validatedUrl, errorDescription);
      }
    });
    webContents.on("did-navigate", (_event, url) => {
      if (!this.isViewAlive(viewKey, webContents)) {
        return;
      }

      if (isInternalErrorPageUrl(url)) {
        this.emitBrowserState(viewKey);
        return;
      }
      this.failedNavigationUrls.delete(viewKey);
      this.failedNavigationStatusCodes.delete(viewKey);
      this.responseStatusCodes.delete(viewKey);
      this.emitBrowserState(viewKey);
    });
    webContents.on("did-navigate-in-page", (_event, url) => {
      if (!this.isViewAlive(viewKey, webContents)) {
        return;
      }

      if (isInternalErrorPageUrl(url)) {
        this.emitBrowserState(viewKey);
        return;
      }
      this.failedNavigationUrls.delete(viewKey);
      this.failedNavigationStatusCodes.delete(viewKey);
      this.responseStatusCodes.delete(viewKey);
      this.emitBrowserState(viewKey);
    });
    webContents.on("page-title-updated", (_event, title) => {
      if (!this.isViewAlive(viewKey, webContents)) {
        return;
      }

      if (isInternalErrorPageUrl(webContents.getURL())) {
        this.emitBrowserState(viewKey);
        return;
      }

      this.emitBrowserState(viewKey);
    });
  }

  handleBrowserShortcut(input: Electron.Input) {
    if (isBrowserReloadShortcut(input)) {
      try {
        this.reload();
      } catch {
        // 起始页没有 WebContentsView 时，拦截快捷键，避免刷新 renderer 丢失标签状态。
      }
      return true;
    }

    if (isBrowserDevToolsShortcut(input)) {
      try {
        this.openDevTools();
      } catch {
        // 起始页没有对应网页内容时不打开 renderer 开发者工具。
      }
      return true;
    }

    return false;
  }

  private bindMonitor(view: WebContentsView, siteId: string, sessionId: string, viewKey: string) {
    const monitor = new JarvisMonitorController({
      view,
      context: {
        viewKey,
        siteId,
        sessionId,
      },
      isAlive: () => this.isViewAlive(viewKey, view.webContents),
      handleEvent: (event) => this.jarvisScriptRuntime.handleMonitorEvent(event),
      getContentScripts: () => this.jarvisScriptRuntime.getContentScripts(siteId, view.webContents.getURL()),
    });
    this.lifecycle.registerCleanup(viewKey, () => monitor.dispose());
    this.runViewTask(viewKey, monitor.start());
  }

  private async sendJarvisScriptMessageToWebContents(input: {
    siteId?: string;
    sessionId?: string;
    channel: string;
    payload: unknown;
  }) {
    const targetViewKeys = this.resolveMessageTargetViewKeys(input.siteId, input.sessionId);
    const message = JSON.stringify({
      source: "jarvis-script",
      channel: input.channel,
      payload: input.payload,
    });

    for (const viewKey of targetViewKeys) {
      const view = this.views.get(viewKey);
      if (!view || !this.isViewAlive(viewKey, view.webContents)) {
        continue;
      }

      await view.webContents.executeJavaScript(
        `window.dispatchEvent(new MessageEvent('message', { data: ${message} }))`,
        true,
      ).catch((error: unknown) => {
        console.error(`[jarvis-script] ${viewKey} 插件消息投递失败`, error);
      });
    }
  }

  private resolveMessageTargetViewKeys(siteId?: string, sessionId?: string) {
    if (siteId && sessionId) {
      return [createViewKey(siteId, sessionId)];
    }

    if (siteId) {
      return [...this.views.keys()].filter((viewKey) => parseViewKey(viewKey).siteId === siteId);
    }

    return [...this.views.keys()];
  }

  private isPageSuccessful(viewKey: string, currentUrl: string) {
    return Boolean(currentUrl)
      && !isInternalErrorPageUrl(currentUrl)
      && !this.failedNavigationUrls.has(viewKey)
      && !this.failedNavigationStatusCodes.has(viewKey)
      && !this.responseStatusCodes.has(viewKey);
  }

  private isViewAlive(viewKey: string, webContents?: Electron.WebContents) {
    if (this.lifecycle.isClosing(viewKey)) {
      return false;
    }

    const view = this.views.get(viewKey);
    if (!view || view.webContents.isDestroyed()) {
      return false;
    }

    return !webContents || view.webContents === webContents;
  }

  private runViewTask(viewKey: string, task: Promise<unknown>) {
    task.catch((error) => {
      if (!this.isViewAlive(viewKey)) {
        return;
      }
      console.error(`[browser] ${viewKey} 异步任务失败`, error);
    });
  }

  private cleanupViewLifecycle(viewKey: string) {
    this.lifecycle.cleanup(viewKey);
    this.failedNavigationUrls.delete(viewKey);
    this.failedNavigationStatusCodes.delete(viewKey);
    this.responseStatusCodes.delete(viewKey);
  }

  private async loadUrlSafely(url: string, view = this.getActiveViewOrUndefined(), viewKey = this.getActiveViewKey()) {
    if (!view || view.webContents.isDestroyed()) {
      return;
    }

    try {
      await view.webContents.loadURL(url);
      const statusCode = viewKey ? this.responseStatusCodes.get(viewKey) : undefined;
      if (viewKey && statusCode && statusCode >= 400) {
        await this.handleHttpStatusPage(viewKey, url, statusCode);
      }
    } catch (error) {
      if (isNavigationAbort(error)) {
        return;
      }

      await this.loadErrorPage(url, formatNavigationError(error), view, viewKey);
    }
  }

  private async loadMainFrameErrorPage(viewKey: string, url: string, errorText: string) {
    if (isInternalErrorPageUrl(url)) {
      return;
    }

    const view = this.views.get(viewKey);
    if (!view || view.webContents.isDestroyed()) {
      return;
    }

    await this.loadErrorPage(url || this.failedNavigationUrls.get(viewKey) || view.webContents.getURL(), errorText, view, viewKey);
  }

  private async loadErrorPage(url: string, errorText: string, view = this.getActiveViewOrUndefined(), viewKey = this.getActiveViewKey()) {
    if (!view || view.webContents.isDestroyed()) {
      return;
    }

    if (viewKey) {
      this.failedNavigationUrls.set(viewKey, url);
      this.failedNavigationStatusCodes.delete(viewKey);
      this.responseStatusCodes.delete(viewKey);
    }
    await view.webContents.loadURL(createErrorPageUrl({
      kind: "network",
      url,
      errorText,
    })).catch(() => undefined);
    this.emitBrowserState(viewKey, `${errorText}：${url}`);
  }

  private emitBrowserState(viewKey = this.getActiveViewKey(), errorText?: string) {
    if (this.window.isDestroyed() || this.window.webContents.isDestroyed()) {
      return;
    }

    const view = viewKey ? this.views.get(viewKey) : this.getActiveViewOrUndefined();
    const webContents = view?.webContents;
    if (webContents?.isDestroyed()) {
      return;
    }

    const ids = viewKey ? parseViewKey(viewKey) : { siteId: this.siteId, sessionId: this.sessionId };
    const nextState = this.updateViewState(viewKey, view, {
      siteId: ids.siteId,
      sessionId: ids.sessionId,
      errorText,
    });
    this.window.webContents.send("browser:state-changed", nextState);
  }

  private emitHomeState() {
    if (this.window.isDestroyed() || this.window.webContents.isDestroyed()) {
      return;
    }

    this.window.webContents.send("browser:state-changed", {
      ...fallbackBrowserState,
      title: "起始页",
    } satisfies BrowserState);
  }

  private updateViewState(viewKey: string | undefined, view: WebContentsView | undefined, patch: Partial<BrowserState>) {
    const displayUrl = viewKey ? this.failedNavigationUrls.get(viewKey) : undefined;
    const statusCode = viewKey ? this.failedNavigationStatusCodes.get(viewKey) : undefined;
    const nextState = createBrowserState({
      previous: viewKey ? this.viewStates.get(viewKey) : undefined,
      view,
      displayUrl,
      statusCode,
      patch,
    });

    if (viewKey) {
      this.viewStates.set(viewKey, nextState);
    }

    return nextState;
  }

  private emitMetadataUpdate() {
    if (this.window.isDestroyed() || this.window.webContents.isDestroyed()) {
      return;
    }

    this.window.webContents.send("site:metadata-updated", this.store.listSites());
  }

  private getActiveView() {
    const view = this.getActiveViewOrUndefined();
    if (!view) {
      throw new Error("浏览器会话未打开");
    }

    return view;
  }

  private getActiveViewOrUndefined() {
    if (!this.siteId || !this.sessionId) {
      return undefined;
    }

    return this.views.get(createViewKey(this.siteId, this.sessionId));
  }

  private getActiveViewKey() {
    if (!this.siteId || !this.sessionId) {
      return undefined;
    }

    return createViewKey(this.siteId, this.sessionId);
  }

  private activateView(siteId: string, sessionId: string) {
    const activeKey = createViewKey(siteId, sessionId);
    this.viewRegistry.activate(activeKey);
  }

  private activateViewIfCurrent(viewKey: string) {
    if (this.getActiveViewKey() !== viewKey) {
      return;
    }

    const ids = parseViewKey(viewKey);
    this.activateView(ids.siteId, ids.sessionId);
  }

  private isLatestOpenForCurrentView(openRequestId: number, viewKey: string) {
    return this.openRequestSeq === openRequestId && this.getActiveViewKey() === viewKey;
  }

  private destroyView(viewKey: string, view: WebContentsView) {
    this.cleanupViewLifecycle(viewKey);
    this.viewRegistry.removeChildView(viewKey);

    try {
      if (!view.webContents.isDestroyed()) {
        view.webContents.close();
      }
    } catch {
      // Electron may already be tearing down the embedded page during app shutdown.
    }

    if (viewKey === createViewKey(this.siteId ?? "", this.sessionId ?? "")) {
      this.siteId = undefined;
      this.sessionId = undefined;
    }
  }

  private async flushViewSession(view: WebContentsView) {
    if (view.webContents.isDestroyed()) {
      return;
    }

    await flushElectronSession(view.webContents.session);
  }

  private unmountActiveView() {
    this.viewRegistry.unmountActiveView();
  }
}
