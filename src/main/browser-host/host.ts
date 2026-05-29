import { BrowserWindow, WebContentsView, session as electronSession, shell } from "electron";
import { join } from "node:path";
import type {
  BrowserInternalPageId,
  BrowserNavigationResult,
  BrowserRect,
  BrowserState,
  BrowserTab,
  BrowserTabKind,
  CookieRemoveDetails,
  CookieSetDetails,
} from "../../shared/types";
import { clampBrowserBounds, defaultBrowserBounds } from "../browser-bounds";
import { DownloadManager } from "../download-manager";
import {
  createDefaultProfilePartition,
  createSessionPartition,
  flushElectronSession,
  getDefaultProfileSession,
  getElectronSession,
} from "../electron-session-manager";
import { ExtensionRuntime } from "../extension-runtime";
import { HistoryManager } from "../history-manager";
import {
  createInternalErrorPageUrl,
  internalPageUrls,
  isInternalErrorPageUrl,
  isInternalPageUrl,
  registerInternalProtocolForSession,
} from "../internal-protocol";
import { JarvisScriptManager } from "../jarvis-script/manager";
import { JarvisScriptRuntime } from "../jarvis-script/runtime";
import { BrowserOverlayHost } from "../browser-overlay-host";
import {
  createAppMenuItems,
  createDownloadMenuItems,
  createExtensionMenuItems,
  getToolOverlayHeight,
  toolOverlayUrl,
  type BrowserOverlayAction,
  type BrowserOverlayMenuModel,
} from "../browser-overlay-menu";
import { MetadataStore, normalizeHttpUrl } from "../store";
import { ViewLifecycle } from "./lifecycle";
import { JarvisMonitorController } from "./monitor/controller";
import { formatNavigationError, isBrowserDevToolsShortcut, isBrowserReloadShortcut, isNavigationAbort } from "./navigation";
import { resolveNavigationTarget, toNavigationResult, type NavigationTarget } from "./navigation-target";
import { createBrowserState } from "./state";
import { ViewRegistry } from "./view-registry";

const now = () => new Date().toISOString();

type HttpStatusListener = {
  tabIds: Set<string>;
  webContentsIds: Map<number, string>;
};

const createId = () => {
  if (globalThis.crypto?.randomUUID) {
    return globalThis.crypto.randomUUID();
  }

  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
};

export class BrowserHost {
  private readonly views = new Map<string, WebContentsView>();
  private readonly tabs = new Map<string, BrowserTab>();
  private readonly viewStates = new Map<string, BrowserState>();
  private readonly lifecycle = new ViewLifecycle();
  private readonly failedNavigationUrls = new Map<string, string>();
  private readonly failedNavigationStatusCodes = new Map<string, number>();
  private readonly externalNavigationUrls = new Map<string, string>();
  private readonly responseStatusCodes = new Map<string, number>();
  private readonly httpStatusListeners = new Map<string, HttpStatusListener>();
  private tabsChangedQueued = false;
  private activeTabId?: string;
  private bounds = defaultBrowserBounds;
  private readonly downloadManager: DownloadManager;
  private readonly extensionRuntime: ExtensionRuntime;
  private readonly jarvisScriptRuntime: JarvisScriptRuntime;
  private readonly jarvisScriptManager: JarvisScriptManager;
  private readonly viewRegistry: ViewRegistry;
  private readonly browserOverlayHost: BrowserOverlayHost;

  constructor(
    private readonly window: BrowserWindow,
    private readonly store: MetadataStore,
    private readonly historyManager: HistoryManager,
  ) {
    this.viewRegistry = new ViewRegistry(window, this.views, () => this.bounds);
    this.browserOverlayHost = new BrowserOverlayHost(window);
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
      resolveRequestContext: (input) => this.resolveJarvisScriptRequestContext(input),
      sendMessageToWebContents: (input) => this.sendJarvisScriptMessageToWebContents(input),
    });
    this.jarvisScriptManager = new JarvisScriptManager(window, store, this.jarvisScriptRuntime);
  }

  async open(siteId: string, sessionId: string) {
    await this.createSiteTab({ siteId, sessionId });
  }

  async createTab(input: { url?: string; openerTabId?: string } = {}) {
    const opener = input.openerTabId ? this.tabs.get(input.openerTabId) : undefined;
    const openerSiteId = opener?.siteId;
    const openerSessionId = opener?.sessionId;
    const partition = opener?.partition ?? createDefaultProfilePartition();
    const targetSession = openerSiteId && openerSessionId
      ? getElectronSession(openerSiteId, openerSessionId)
      : electronSession.fromPartition(partition);
    const navigationTarget = input.url ? resolveNavigationTarget(input.url) : undefined;
    if (navigationTarget?.kind === "external") {
      await this.openExternalTarget(navigationTarget);
      throw new Error("外部协议不在新标签页中打开");
    }
    if (navigationTarget?.kind === "blocked") {
      throw new Error(navigationTarget.errorText);
    }

    const url = navigationTarget?.url ?? internalPageUrls.newtab;
    const isSessionChildTab = Boolean(input.url && openerSiteId && openerSessionId);
    const kind: BrowserTabKind = isSessionChildTab ? "site" : input.url ? "default" : "internal";
    const tab = this.createTabRecord({
      kind,
      url,
      title: kind === "internal" ? "新标签页" : "新标签",
      partition,
      siteId: openerSiteId,
      sessionId: openerSessionId,
      parentTabId: isSessionChildTab ? opener?.id : undefined,
      openerTabId: input.openerTabId,
      internalPageId: kind === "internal" ? "newtab" : undefined,
    });

    if (tab.kind === "default") {
      await this.extensionRuntime.loadEnabledForDefaultProfile();
      await this.jarvisScriptRuntime.refreshUserScriptWorkers();
    }
    if (isSessionChildTab && openerSiteId) {
      const site = this.store.getSite(openerSiteId);
      if (site) {
        this.runViewTask(tab.id, this.extensionRuntime.loadEnabledForSite(site));
      }
    }
    await this.createViewForTab(tab, targetSession);
    await this.loadUrlSafely(url, this.views.get(tab.id), tab.id);
    await this.activateTab(tab.id, { emitTabs: false });
    this.emitTabsChanged();
    return structuredClone(tab);
  }

  async createSiteTab(input: { siteId: string; sessionId: string }) {
    const site = this.store.getSite(input.siteId);
    const siteSession = this.store.getSession(input.siteId, input.sessionId);
    if (!site || !siteSession) {
      throw new Error("会话不存在");
    }

    const existing = [...this.tabs.values()].find((tab) =>
      tab.kind === "site" && tab.siteId === input.siteId && tab.sessionId === input.sessionId,
    );
    if (existing) {
      await this.activateTab(existing.id);
      return structuredClone(existing);
    }

    const partition = createSessionPartition(input.siteId, input.sessionId);
    const tab = this.createTabRecord({
      kind: "site",
      url: site.url,
      title: siteSession.name,
      favicon: site.faviconPath || site.faviconUrl,
      siteId: input.siteId,
      sessionId: input.sessionId,
      partition,
    });
    const targetSession = getElectronSession(input.siteId, input.sessionId);

    await this.createViewForTab(tab, targetSession);
    await this.activateTab(tab.id, { emitTabs: false });
    this.emitBrowserState(tab.id);
    this.emitTabsChanged();
    this.runViewTask(tab.id, this.prepareAndLoadSiteTab(tab.id, site));
    return structuredClone(tab);
  }

  async openInternalPage(input: { pageId: BrowserInternalPageId }) {
    const existing = [...this.tabs.values()].find((tab) => tab.kind === "internal" && tab.internalPageId === input.pageId);
    if (existing) {
      await this.activateTab(existing.id);
      return structuredClone(existing);
    }

    const url = internalPageUrls[input.pageId];
    const tab = this.createTabRecord({
      kind: "internal",
      url,
      title: titleForInternalPage(input.pageId),
      partition: createDefaultProfilePartition(),
      internalPageId: input.pageId,
    });

    await this.createViewForTab(tab, getDefaultProfileSession());
    await this.activateTab(tab.id, { emitTabs: false });
    await this.loadUrlSafely(url, this.views.get(tab.id), tab.id);
    this.emitTabsChanged();
    return structuredClone(tab);
  }

  listTabs() {
    return {
      activeTabId: this.activeTabId,
      tabs: [...this.tabs.values()].map((tab) => structuredClone(tab)),
    };
  }

  reorderTabs(tabIds: string[]) {
    const requested = tabIds.filter((tabId) => this.tabs.has(tabId));
    if (!requested.length) {
      return;
    }

    const requestedIds = new Set(requested);
    const nextTabs = new Map<string, BrowserTab>();
    for (const tabId of requested) {
      const tab = this.tabs.get(tabId);
      if (tab) {
        nextTabs.set(tabId, tab);
      }
    }
    for (const [tabId, tab] of this.tabs) {
      if (!requestedIds.has(tabId)) {
        nextTabs.set(tabId, tab);
      }
    }

    this.tabs.clear();
    for (const [tabId, tab] of nextTabs) {
      this.tabs.set(tabId, tab);
    }
    this.emitTabsChanged();
  }

  async activateTab(tabId: string, options: { emitTabs?: boolean } = {}) {
    const tab = this.tabs.get(tabId);
    if (!tab) {
      throw new Error("标签不存在");
    }

    this.browserOverlayHost.closeOverlay();
    const wasActive = this.activeTabId === tab.id;
    this.activeTabId = tab.id;
    this.viewRegistry.activate(tab.id);
    this.emitBrowserState(tab.id);
    if (!wasActive && options.emitTabs !== false) {
      this.emitTabsChanged();
    }
  }

  async closeTab(tabId: string) {
    const tab = this.tabs.get(tabId);
    const view = this.views.get(tabId);
    if (!tab) {
      return;
    }

    if (view) {
      await this.flushViewSession(view);
      this.destroyView(tabId, view);
      this.views.delete(tabId);
    }
    this.tabs.delete(tabId);
    this.viewStates.delete(tabId);
    this.cleanupViewLifecycle(tabId);

    if (this.activeTabId === tabId) {
      const nextTab = [...this.tabs.values()].at(-1);
      this.activeTabId = undefined;
      if (nextTab) {
        await this.activateTab(nextTab.id, { emitTabs: false });
      } else {
        await this.openInternalPage({ pageId: "newtab" });
        return;
      }
    }

    this.emitTabsChanged();
  }

  async navigateTab(tabId: string, url: string): Promise<BrowserNavigationResult> {
    const tab = this.requireTab(tabId);
    const previousUrl = tab.url;
    const previousTitle = tab.title;
    const target = resolveNavigationTarget(url);

    if (target.kind === "external") {
      await this.openExternalTarget(target, tabId);
      this.emitBrowserState(tabId);
      this.emitTabsChanged();
      return toNavigationResult(target);
    }

    if (target.kind === "blocked") {
      await this.loadErrorPage(target.url, target.errorText, this.views.get(tabId), tabId);
      return toNavigationResult(target);
    }

    tab.url = target.url;
    tab.updatedAt = now();
    await this.loadUrlSafely(target.url, this.views.get(tabId), tabId);
    if (this.failedNavigationUrls.has(tabId)) {
      tab.url = previousUrl;
      tab.title = previousTitle;
      tab.updatedAt = now();
      this.emitTabsChanged();
      return {
        kind: "blocked",
        url: target.url,
        errorText: this.failedNavigationUrls.get(tabId) === target.url
          ? this.viewStates.get(tabId)?.errorText || "页面加载失败"
          : "页面加载失败",
      };
    }

    this.emitTabsChanged();
    return toNavigationResult(target);
  }

  async navigate(url: string) {
    return this.navigateTab(this.requireActiveTab().id, url);
  }

  back() {
    const view = this.getActiveView();
    if (view.webContents.navigationHistory.canGoBack()) {
      view.webContents.navigationHistory.goBack();
    }
  }

  forward() {
    const view = this.getActiveView();
    if (view.webContents.navigationHistory.canGoForward()) {
      view.webContents.navigationHistory.goForward();
    }
  }

  async reload() {
    const tab = this.requireActiveTab();
    const targetUrl = this.failedNavigationUrls.get(tab.id);
    if (targetUrl) {
      await this.reloadFailedNavigation(tab.id, targetUrl, this.getActiveView());
      return;
    }

    this.getActiveView().webContents.reload();
  }

  openDevTools() {
    const webContents = this.getActiveView().webContents;
    if (webContents.isDevToolsOpened()) {
      webContents.closeDevTools();
      return;
    }

    const restoreMainWindowFocus = () => {
      if (!this.window.isDestroyed() && !this.window.isFocused()) {
        this.window.focus();
      }
    };

    webContents.once("devtools-opened", restoreMainWindowFocus);

    try {
      // Intentionally omit `mode` so Chromium can reuse the last selected dock state
      // instead of forcing Electron's non-dockable `detach` mode.
      (webContents.openDevTools as (options?: { activate?: boolean; title?: string }) => void)({
        activate: false,
      });
    } catch (error) {
      webContents.removeListener("devtools-opened", restoreMainWindowFocus);
      throw error;
    }
  }

  async reloadErrorPage() {
    const tab = this.requireActiveTab();
    const targetUrl = this.failedNavigationUrls.get(tab.id);
    if (!targetUrl) {
      await this.reload();
      return;
    }

    await this.reloadFailedNavigation(tab.id, targetUrl, this.getActiveView());
  }

  private async reloadFailedNavigation(tabId: string, targetUrl: string, view: WebContentsView) {
    this.failedNavigationUrls.delete(tabId);
    this.failedNavigationStatusCodes.delete(tabId);
    this.responseStatusCodes.delete(tabId);
    await this.loadUrlSafely(targetUrl, view, tabId);
  }

  stop() {
    this.getActiveView().webContents.stop();
  }

  async showHome() {
    await this.openInternalPage({ pageId: "newtab" });
  }

  hideEmbeddedView() {
    this.browserOverlayHost.closeOverlay();
    this.unmountActiveView();
  }

  showActiveView() {
    if (this.activeTabId) {
      this.viewRegistry.activate(this.activeTabId);
    }
  }

  setBounds(rect: BrowserRect) {
    this.bounds = clampBrowserBounds(rect);
    this.getActiveViewOrUndefined()?.setBounds(this.bounds);
  }

  async close() {
    this.browserOverlayHost.closeOverlay();
    for (const [viewKey, view] of this.views) {
      await this.flushViewSession(view);
      this.destroyView(viewKey, view);
    }
    this.views.clear();
    this.tabs.clear();
    this.viewStates.clear();
    this.lifecycle.clear();
    this.failedNavigationUrls.clear();
    this.failedNavigationStatusCodes.clear();
    this.responseStatusCodes.clear();
    this.httpStatusListeners.clear();
    this.activeTabId = undefined;
    this.viewRegistry.setMountedViewKey(undefined);
    this.jarvisScriptRuntime.close();
  }

  async closeSession(siteId: string, sessionId: string) {
    const matchingTabs = [...this.tabs.values()].filter((tab) => tab.siteId === siteId && tab.sessionId === sessionId);
    for (const tab of matchingTabs) {
      await this.closeTab(tab.id);
    }
  }

  getActiveSiteId() {
    return this.requireActiveTabOrUndefined()?.siteId;
  }

  isActiveSession(siteId: string, sessionId: string) {
    const tab = this.requireActiveTabOrUndefined();
    return tab?.siteId === siteId && tab.sessionId === sessionId;
  }

  getDebugState() {
    return {
      activeTabId: this.activeTabId,
      viewCount: this.views.size,
      viewKeys: [...this.views.keys()],
    };
  }

  emitSiteMetadataUpdated() {
    this.emitMetadataUpdate();
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
    this.browserOverlayHost.closeOverlay();
    return this.extensionRuntime.disableGlobal(extensionId);
  }

  async uninstallGlobalExtension(extensionId: string) {
    this.browserOverlayHost.closeOverlay();
    await this.extensionRuntime.uninstallGlobal(extensionId);
  }

  async enableSiteExtension(siteId: string, extensionId: string) {
    return this.extensionRuntime.enableSite(siteId, extensionId);
  }

  async disableSiteExtension(siteId: string, extensionId: string) {
    this.browserOverlayHost.closeOverlay();
    return this.extensionRuntime.disableSite(siteId, extensionId);
  }

  async uninstallSiteExtension(siteId: string, extensionId: string) {
    this.browserOverlayHost.closeOverlay();
    await this.extensionRuntime.uninstallSite(siteId, extensionId);
  }

  async openExtensionPopup(input: { siteId: string; sessionId: string; extensionId: string; anchor: BrowserRect }) {
    const activeTab = this.requireActiveTab();
    if (activeTab.siteId !== input.siteId || activeTab.sessionId !== input.sessionId) {
      throw new Error("扩展程序面板只能在当前活跃会话中打开");
    }

    const site = this.store.getSite(input.siteId);
    const siteSession = this.store.getSession(input.siteId, input.sessionId);
    if (!site || !siteSession) {
      throw new Error("会话不存在");
    }

    const extension = this.store.getGlobalExtension(input.extensionId)
      ?? site.extensions.find((item) => item.id === input.extensionId);
    if (!extension || !extension.enabled) {
      throw new Error("扩展程序未启用");
    }

    const defaultPopup = extension.action?.defaultPopup?.trim();
    if (!defaultPopup) {
      throw new Error("扩展程序未声明 popup 面板");
    }

    const targetSession = getElectronSession(input.siteId, input.sessionId);
    const loadedExtension = targetSession.getAllExtensions()
      .find((item) => item.id === extension.id || item.path === extension.path);
    if (!loadedExtension) {
      throw new Error("扩展程序尚未加载到当前会话");
    }

    const popupKey = `extension-action:${input.siteId}:${input.sessionId}:${loadedExtension.id}:${defaultPopup}`;
    if (this.browserOverlayHost.isActive(popupKey)) {
      this.browserOverlayHost.closeOverlay();
      return;
    }

    const activeView = this.getActiveView();
    const popupUrl = new URL(defaultPopup, loadedExtension.url);
    popupUrl.searchParams.set("jarvisTabId", String(activeView.webContents.id));
    popupUrl.searchParams.set("jarvisTabUrl", activeView.webContents.getURL());
    const title = activeView.webContents.getTitle();
    if (title) {
      popupUrl.searchParams.set("jarvisTabTitle", title);
    }

    const { popupWindow } = this.browserOverlayHost.openOverlayWindow({
      key: popupKey,
      anchor: input.anchor,
      width: 360,
      height: 520,
      webPreferences: {
        session: targetSession,
        preload: join(__dirname, "../../preload/extension-popup-preload.js"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    await popupWindow.loadURL(popupUrl.toString()).catch((error: unknown) => {
      this.browserOverlayHost.closeOverlay();
      throw error;
    });
  }

  closeExtensionPopup() {
    this.browserOverlayHost.closeOverlay();
  }

  async openExtensionMenu(input: { anchor: BrowserRect }) {
    const activeTab = this.requireActiveTabOrUndefined();
    const site = activeTab?.siteId ? this.store.getSite(activeTab.siteId) : undefined;
    const extensions = [
      ...this.store.listGlobalExtensions(),
      ...(site?.extensions ?? []),
    ].filter((extension) => extension.enabled && Boolean(extension.action?.defaultPopup));
    await this.openToolMenuOverlay({
      key: "extension-menu",
      title: "扩展程序",
      subtitle: `${extensions.length} 个可操作扩展`,
      anchor: input.anchor,
      width: 310,
      items: createExtensionMenuItems({
        extensions,
        canInstallSiteExtension: Boolean(site),
      }),
      emptyText: "当前没有可弹出的扩展",
    });
  }

  async openDownloadsBubble(input: { anchor: BrowserRect }) {
    const downloads = this.store.listDownloads();
    await this.openToolMenuOverlay({
      key: "downloads-bubble",
      title: "下载内容",
      subtitle: downloads.some((download) => download.state === "progressing") ? "正在下载" : "最近下载",
      anchor: input.anchor,
      width: 320,
      items: createDownloadMenuItems(downloads),
      emptyText: "暂无下载记录",
    });
  }

  async openAppMenu(input: { anchor: BrowserRect }) {
    await this.openToolMenuOverlay({
      key: "app-menu",
      title: "更多",
      anchor: input.anchor,
      width: 240,
      items: createAppMenuItems(),
    });
  }

  closeOverlay() {
    this.browserOverlayHost.closeOverlay();
  }

  private async openToolMenuOverlay(input: BrowserOverlayMenuModel & {
    key: string;
    anchor: BrowserRect;
    width: number;
  }) {
    await this.browserOverlayHost.openToolOverlay({
      key: input.key,
      anchor: input.anchor,
      width: input.width,
      height: getToolOverlayHeight(input),
      url: toolOverlayUrl,
      data: {
        title: input.title,
        subtitle: input.subtitle,
        anchor: input.anchor,
        items: input.items,
        emptyText: input.emptyText,
      } satisfies BrowserOverlayMenuModel,
    });
  }

  async handleOverlayAction(input: { action: BrowserOverlayAction; id: string; anchor?: BrowserRect }) {
    if (input.action === "extension-popup") {
      if (!input.anchor) {
        throw new Error("浮层动作缺少锚点");
      }
      this.browserOverlayHost.closeOverlay();
      const activeTab = this.requireActiveTab();
      if (!activeTab.siteId || !activeTab.sessionId) {
        throw new Error("当前标签不是站点会话");
      }
      await this.openExtensionPopup({
        siteId: activeTab.siteId,
        sessionId: activeTab.sessionId,
        extensionId: input.id,
        anchor: input.anchor,
      });
      return;
    }

    this.browserOverlayHost.closeOverlay();
    if (input.action === "extensions") {
      await this.openInternalPage({ pageId: "extensions" });
      return;
    }

    if (input.action === "install-site-extension") {
      const activeTab = this.requireActiveTab();
      if (activeTab.siteId) {
        await this.installSiteUnpacked(activeTab.siteId);
      }
      return;
    }

    if (input.action === "downloads") {
      await this.openInternalPage({ pageId: "downloads" });
      return;
    }

    if (input.action === "settings") {
      await this.openInternalPage({ pageId: "settings" });
      return;
    }

    if (input.action === "history") {
      await this.openInternalPage({ pageId: "history" });
      return;
    }

    if (input.action === "session-sync") {
      this.browserOverlayHost.closeOverlay();
      setTimeout(() => {
        if (!this.window.isDestroyed() && !this.window.webContents.isDestroyed()) {
          this.window.webContents.send("session-sync:open-dialog", { scope: "global" });
        }
      }, 0);
      return;
    }

    if (input.action === "clear-browsing-data") {
      await this.openInternalPage({ pageId: "clear-browsing-data" });
      return;
    }

    if (input.action === "jarvis-script") {
      await this.openInternalPage({ pageId: "jarvis-script" });
    }
  }

  async setActiveSessionCookie(details: CookieSetDetails) {
    const active = this.requireActiveSiteSession();
    const targetSession = getElectronSession(active.siteId, active.sessionId);
    await targetSession.cookies.set(toElectronCookieSetDetails(details));
  }

  async removeActiveSessionCookie(details: CookieRemoveDetails) {
    const active = this.requireActiveSiteSession();
    const targetSession = getElectronSession(active.siteId, active.sessionId);
    await targetSession.cookies.remove(details.url, details.name);
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
    this.downloadManager.bindSession(createDefaultProfilePartition(), getDefaultProfileSession());
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

  handleBrowserShortcut(input: Electron.Input) {
    if (isBrowserReloadShortcut(input)) {
      void this.reload().catch(() => {
        // 没有激活标签时忽略浏览器刷新快捷键。
      });
      return true;
    }

    if (isBrowserDevToolsShortcut(input)) {
      try {
        this.openDevTools();
      } catch {
        // 没有激活标签时不打开 renderer 开发者工具。
      }
      return true;
    }

    return false;
  }

  private createTabRecord(input: {
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
  }) {
    const timestamp = now();
    const tab: BrowserTab = {
      id: createId(),
      kind: input.kind,
      url: input.url,
      title: input.title,
      favicon: input.favicon,
      siteId: input.siteId,
      sessionId: input.sessionId,
      partition: input.partition,
      parentTabId: input.parentTabId,
      openerTabId: input.openerTabId,
      internalPageId: input.internalPageId,
      pinnedExtensionIds: [],
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.tabs.set(tab.id, tab);
    return tab;
  }

  private patchTab(tab: BrowserTab, patch: Partial<Pick<BrowserTab, "url" | "title" | "favicon">>) {
    let changed = false;
    if (patch.url !== undefined && tab.url !== patch.url) {
      tab.url = patch.url;
      changed = true;
    }
    if (patch.title !== undefined && tab.title !== patch.title) {
      tab.title = patch.title;
      changed = true;
    }
    if (Object.hasOwn(patch, "favicon") && tab.favicon !== patch.favicon) {
      tab.favicon = patch.favicon;
      changed = true;
    }
    if (changed) {
      tab.updatedAt = now();
    }
    return changed;
  }

  private async createViewForTab(tab: BrowserTab, targetSession: Electron.Session) {
    registerInternalProtocolForSession(targetSession);
    this.downloadManager.bindSession(tab.id, targetSession);

    const view = new WebContentsView({
      webPreferences: {
        session: targetSession,
        preload: tab.kind === "internal"
          ? join(__dirname, "../../preload/preload.js")
          : join(__dirname, "../../preload/web-page-preload.js"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: tab.kind !== "internal",
      },
    });

    this.views.set(tab.id, view);
    this.lifecycle.markOpen(tab.id);
    this.registerHttpStatusListener(tab.id, tab.partition, targetSession, view.webContents.id);
    this.bindNavigationEvents(view, tab.id);
    if (tab.kind !== "internal") {
      this.bindMonitor(view, tab.id, tab.siteId, tab.sessionId);
    }
    this.updateViewState(tab.id, view, {
      tabId: tab.id,
      kind: tab.kind,
      siteId: tab.siteId,
      sessionId: tab.sessionId,
      partition: tab.partition,
      url: tab.url,
      title: tab.title,
      favicon: tab.favicon,
    });
  }

  private registerHttpStatusListener(tabId: string, partition: string, targetSession: Electron.Session, webContentsId: number) {
    const existing = this.httpStatusListeners.get(partition);
    if (existing) {
      existing.tabIds.add(tabId);
      existing.webContentsIds.set(webContentsId, tabId);
      return;
    }

    const listener: HttpStatusListener = {
      tabIds: new Set([tabId]),
      webContentsIds: new Map([[webContentsId, tabId]]),
    };
    this.httpStatusListeners.set(partition, listener);
    targetSession.webRequest.onCompleted({ urls: ["http://*/*", "https://*/*"] }, (details) => {
      if (details.resourceType !== "mainFrame" || details.statusCode < 400) {
        return;
      }

      if (details.webContentsId === undefined) {
        return;
      }

      const targetTabId = listener.webContentsIds.get(details.webContentsId);
      if (!targetTabId) {
        return;
      }

      const view = this.views.get(targetTabId);
      if (!view || !this.isViewAlive(targetTabId, view.webContents)) {
        return;
      }

      this.responseStatusCodes.set(targetTabId, details.statusCode);
      void this.handleHttpStatusPage(targetTabId, details.url, details.statusCode);
    });
  }

  private unregisterHttpStatusListener(tabId: string) {
    const tab = this.tabs.get(tabId);
    if (!tab) {
      return;
    }

    const listener = this.httpStatusListeners.get(tab.partition);
    if (!listener) {
      return;
    }

    listener.tabIds.delete(tabId);
    for (const [webContentsId, mappedTabId] of listener.webContentsIds) {
      if (mappedTabId === tabId) {
        listener.webContentsIds.delete(webContentsId);
      }
    }

    if (listener.tabIds.size === 0) {
      this.httpStatusListeners.delete(tab.partition);
      electronSession.fromPartition(tab.partition).webRequest.onCompleted(null);
    }
  }

  private bindNavigationEvents(view: WebContentsView, tabId: string) {
    const webContents = view.webContents;
    webContents.setWindowOpenHandler(({ url }) => {
      if (!this.isViewAlive(tabId, webContents)) {
        return { action: "deny" };
      }

      const target = resolveNavigationTarget(url);
      if (target.kind === "browser") {
        void this.createTab({ url: target.url, openerTabId: tabId });
      } else if (target.kind === "external") {
        void this.openExternalTarget(target, tabId);
      } else {
        void this.loadErrorPage(target.url, target.errorText, this.views.get(tabId), tabId);
      }
      return { action: "deny" };
    });
    webContents.on("will-navigate", (event) => {
      if (!this.isViewAlive(tabId, webContents)) {
        return;
      }

      void this.handleMainFrameNavigationEvent(event, tabId, event.url, event.isMainFrame);
    });
    webContents.on("will-redirect", (event) => {
      if (!this.isViewAlive(tabId, webContents)) {
        return;
      }

      void this.handleMainFrameNavigationEvent(event, tabId, event.url, event.isMainFrame);
    });
    webContents.on("did-start-loading", () => this.emitBrowserStateIfAlive(tabId, webContents));
    webContents.on("did-finish-load", () => this.emitBrowserStateIfAlive(tabId, webContents));
    webContents.on("did-stop-loading", () => this.emitBrowserStateIfAlive(tabId, webContents));
    webContents.on("before-mouse-event", (_event, mouse) => {
      if (this.isViewAlive(tabId, webContents) && mouse.type === "mouseDown") {
        this.browserOverlayHost.dismissFromPageInteraction();
      }
    });
    webContents.on("before-input-event", (event, input) => {
      if (this.isViewAlive(tabId, webContents) && this.browserOverlayHost.dismissFromKeyboard(input)) {
        event.preventDefault();
        return;
      }

      if (this.isViewAlive(tabId, webContents) && this.handleBrowserShortcut(input)) {
        event.preventDefault();
      }
    });
    webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedUrl, isMainFrame) => {
      if (
        this.isViewAlive(tabId, webContents)
        && isMainFrame
        && errorCode !== -3
        && validatedUrl !== this.externalNavigationUrls.get(tabId)
      ) {
        void this.loadMainFrameErrorPage(tabId, validatedUrl, errorDescription);
      }
    });
    webContents.on("did-navigate", (_event, url) => this.handleNavigation(tabId, url));
    webContents.on("did-navigate-in-page", (_event, url) => this.handleNavigation(tabId, url));
    webContents.on("page-title-updated", (_event, title) => {
      if (!this.isViewAlive(tabId, webContents)) {
        return;
      }

      const tab = this.tabs.get(tabId);
      let tabChanged = false;
      if (tab && !isInternalErrorPageUrl(webContents.getURL())) {
        tabChanged = this.patchTab(tab, {
          title: this.resolveCanonicalTabTitle(tab, title),
        });
      }
      this.emitBrowserState(tabId);
      if (tabChanged) {
        this.emitTabsChanged();
      }
    });
  }

  private handleNavigation(tabId: string, url: string) {
    const view = this.views.get(tabId);
    if (!view || !this.isViewAlive(tabId, view.webContents)) {
      return;
    }

    if (isInternalErrorPageUrl(url)) {
      this.emitBrowserState(tabId);
      return;
    }

    this.failedNavigationUrls.delete(tabId);
    this.failedNavigationStatusCodes.delete(tabId);
    this.externalNavigationUrls.delete(tabId);
    this.responseStatusCodes.delete(tabId);
    const tab = this.tabs.get(tabId);
    let tabChanged = false;
    if (tab) {
      const canonicalUrl = this.resolveCanonicalTabUrl(tab, url);
      tabChanged = this.patchTab(tab, {
        url: canonicalUrl,
        title: this.resolveCanonicalTabTitle(tab, view.webContents.getTitle()),
      });
      if (tab.kind !== "internal") {
        this.recordHistoryNavigation(tab, canonicalUrl, view.webContents.getTitle());
      }
    }
    this.emitBrowserState(tabId);
    if (tabChanged) {
      this.emitTabsChanged();
    }
  }

  private resolveCanonicalTabUrl(tab: BrowserTab, navigatedUrl: string) {
    if (tab.kind === "internal") {
      return tab.internalPageId ? internalPageUrls[tab.internalPageId] : tab.url;
    }

    return isInternalPageUrl(navigatedUrl) ? tab.url : navigatedUrl;
  }

  private resolveCanonicalTabTitle(tab: BrowserTab, pageTitle?: string) {
    if (tab.kind === "internal" && tab.internalPageId) {
      return titleForInternalPage(tab.internalPageId);
    }

    return pageTitle || tab.title;
  }

  private emitBrowserStateIfAlive(tabId: string, webContents: Electron.WebContents) {
    if (this.isViewAlive(tabId, webContents)) {
      this.emitBrowserState(tabId);
    }
  }

  private async handleMainFrameNavigationEvent(
    event: Electron.Event<Electron.WebContentsWillNavigateEventParams | Electron.WebContentsWillRedirectEventParams>,
    tabId: string,
    url: string,
    isMainFrame: boolean,
  ) {
    if (!isMainFrame) {
      return;
    }

    const target = resolveNavigationTarget(url);
    if (target.kind === "browser") {
      this.externalNavigationUrls.delete(tabId);
      return;
    }

    event.preventDefault();
    if (target.kind === "external") {
      await this.openExternalTarget(target, tabId);
      this.emitBrowserState(tabId);
      return;
    }

    await this.loadErrorPage(target.url, target.errorText, this.views.get(tabId), tabId);
  }

  private async handleHttpStatusPage(tabId: string, url: string, statusCode: number) {
    if (isInternalErrorPageUrl(url) || statusCode < 400) {
      return;
    }

    const view = this.views.get(tabId);
    if (!view || view.webContents.isDestroyed()) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 400));
    if (!this.views.has(tabId) || view.webContents.isDestroyed()) {
      return;
    }

    const bodyText = await view.webContents.executeJavaScript(
      "document.body ? document.body.innerText.trim() : ''",
      true,
    ).catch(() => "");
    if (bodyText) {
      this.emitBrowserState(tabId, `HTTP ${statusCode}`);
      return;
    }

    await this.showHttpErrorPage(tabId, url, statusCode);
  }

  private async showHttpErrorPage(tabId: string, url: string, statusCode: number) {
    const view = this.views.get(tabId);
    if (!view || view.webContents.isDestroyed()) {
      return;
    }

    this.failedNavigationUrls.set(tabId, url);
    this.failedNavigationStatusCodes.set(tabId, statusCode);
    this.responseStatusCodes.delete(tabId);
    await view.webContents.loadURL(createInternalErrorPageUrl({
      kind: "http",
      url,
      statusCode,
      errorText: `请求失败，状态码：${statusCode}`,
    }));
    this.emitBrowserState(tabId, `HTTP ${statusCode}`);
  }

  private bindMonitor(view: WebContentsView, viewKey: string, siteId?: string, sessionId?: string) {
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

  private recordHistoryNavigation(tab: BrowserTab, url: string, title?: string) {
    void this.historyManager.recordNavigation({
      tabId: tab.id,
      siteId: tab.siteId,
      sessionId: tab.sessionId,
      partition: tab.partition,
      url,
      title,
    }).catch((error: unknown) => {
      console.error(`[history] ${tab.id} 导航记录失败`, error);
    });
  }

  private async prepareAndLoadSiteTab(tabId: string, site: NonNullable<ReturnType<MetadataStore["getSite"]>>) {
    const view = this.views.get(tabId);
    if (!view || !this.isViewAlive(tabId, view.webContents)) {
      return;
    }

    await this.extensionRuntime.loadEnabledForSite(site);
    await this.jarvisScriptRuntime.refreshUserScriptWorkers();
    if (!this.isViewAlive(tabId, view.webContents)) {
      return;
    }

    await this.loadUrlSafely(normalizeHttpUrl(site.url), view, tabId);
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
        console.error(`[jarvis-script] ${viewKey} 扩展程序消息投递失败`, error);
      });
    }
  }

  private resolveMessageTargetViewKeys(siteId?: string, sessionId?: string) {
    if (siteId && sessionId) {
      return [...this.tabs.values()]
        .filter((tab) => tab.siteId === siteId && tab.sessionId === sessionId)
        .map((tab) => tab.id);
    }

    if (siteId) {
      return [...this.tabs.values()].filter((tab) => tab.siteId === siteId).map((tab) => tab.id);
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
    this.unregisterHttpStatusListener(viewKey);
    this.failedNavigationUrls.delete(viewKey);
    this.failedNavigationStatusCodes.delete(viewKey);
    this.externalNavigationUrls.delete(viewKey);
    this.responseStatusCodes.delete(viewKey);
  }

  private async loadUrlSafely(url: string, view = this.getActiveViewOrUndefined(), viewKey = this.activeTabId) {
    if (!view || view.webContents.isDestroyed()) {
      return;
    }

    const target = resolveNavigationTarget(url);
    if (target.kind === "external") {
      await this.openExternalTarget(target, viewKey);
      return;
    }
    if (target.kind === "blocked") {
      await this.loadErrorPage(target.url, target.errorText, view, viewKey);
      return;
    }

    try {
      if (viewKey) {
        this.externalNavigationUrls.delete(viewKey);
      }
      await view.webContents.loadURL(target.url);
      const statusCode = viewKey ? this.responseStatusCodes.get(viewKey) : undefined;
      if (viewKey && statusCode && statusCode >= 400) {
        await this.handleHttpStatusPage(viewKey, target.url, statusCode);
      }
    } catch (error) {
      if (isNavigationAbort(error)) {
        return;
      }

      await this.loadErrorPage(target.url, formatNavigationError(error), view, viewKey);
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

  private async loadErrorPage(url: string, errorText: string, view = this.getActiveViewOrUndefined(), viewKey = this.activeTabId) {
    if (!view || view.webContents.isDestroyed()) {
      return;
    }

    if (viewKey) {
      this.failedNavigationUrls.set(viewKey, url);
      this.failedNavigationStatusCodes.delete(viewKey);
      this.externalNavigationUrls.delete(viewKey);
      this.responseStatusCodes.delete(viewKey);
    }
    await view.webContents.loadURL(createInternalErrorPageUrl({
      kind: "network",
      url,
      errorText,
    })).catch(() => undefined);
    this.emitBrowserState(viewKey, `${errorText}：${url}`);
  }

  private emitBrowserState(viewKey = this.activeTabId, errorText?: string) {
    if (this.window.isDestroyed() || this.window.webContents.isDestroyed()) {
      return;
    }

    const view = viewKey ? this.views.get(viewKey) : undefined;
    const webContents = view?.webContents;
    if (webContents?.isDestroyed()) {
      return;
    }

    const tab = viewKey ? this.tabs.get(viewKey) : undefined;
    const errorUrl = viewKey ? this.failedNavigationUrls.get(viewKey) : undefined;
    const statusCode = viewKey ? this.failedNavigationStatusCodes.get(viewKey) : undefined;
    const tabPatch = tab
      ? {
        tabId: tab.id,
        kind: tab.kind,
        siteId: tab.siteId,
        sessionId: tab.sessionId,
        partition: tab.partition,
        favicon: tab.favicon,
        url: tab.url,
        title: errorUrl
          ? statusCode ? `HTTP ${statusCode}` : "网页无法打开"
          : this.resolveCanonicalTabTitle(tab),
      } satisfies Partial<BrowserState>
      : {};
    const nextState = this.updateViewState(viewKey, view, {
      ...tabPatch,
      errorText,
    });
    this.window.webContents.send("browser:state-changed", nextState);
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

  private async openExternalTarget(target: NavigationTarget & { kind: "external" }, viewKey?: string) {
    try {
      await shell.openExternal(target.url);
      if (viewKey) {
        this.externalNavigationUrls.set(viewKey, target.url);
        this.failedNavigationUrls.delete(viewKey);
        this.failedNavigationStatusCodes.delete(viewKey);
        this.responseStatusCodes.delete(viewKey);
      }
    } catch (error) {
      await this.loadErrorPage(
        target.url,
        `外部协议无法打开：${formatNavigationError(error)}`,
        viewKey ? this.views.get(viewKey) : undefined,
        viewKey,
      );
    }
  }

  private emitTabsChanged() {
    if (this.window.isDestroyed() || this.window.webContents.isDestroyed()) {
      return;
    }

    if (this.tabsChangedQueued) {
      return;
    }

    this.tabsChangedQueued = true;
    queueMicrotask(() => {
      this.tabsChangedQueued = false;
      if (this.window.isDestroyed() || this.window.webContents.isDestroyed()) {
        return;
      }

      this.window.webContents.send("browser:tabs-changed", this.listTabs());
    });
  }

  private emitMetadataUpdate() {
    if (this.window.isDestroyed() || this.window.webContents.isDestroyed()) {
      return;
    }

    const sites = this.store.listSites();
    const tabsChanged = this.syncSiteTabMetadata(sites);
    this.window.webContents.send("site:metadata-updated", sites);
    if (tabsChanged) {
      this.emitTabsChanged();
    }
  }

  private syncSiteTabMetadata(sites = this.store.listSites()) {
    const sitesById = new Map(sites.map((site) => [site.id, site]));
    let changed = false;
    for (const tab of this.tabs.values()) {
      if (tab.kind !== "site" || !tab.siteId) {
        continue;
      }

      const site = sitesById.get(tab.siteId);
      if (!site) {
        continue;
      }

      const favicon = site.faviconPath || site.faviconUrl;
      const nextFavicon = favicon || undefined;
      changed = this.patchTab(tab, { favicon: nextFavicon }) || changed;
      const state = this.viewStates.get(tab.id);
      if (state && state.favicon !== nextFavicon) {
        this.viewStates.set(tab.id, {
          ...state,
          favicon: nextFavicon,
        });
      }
    }
    return changed;
  }

  private getActiveView() {
    const view = this.getActiveViewOrUndefined();
    if (!view) {
      throw new Error("浏览器标签未打开");
    }

    return view;
  }

  private getActiveViewOrUndefined() {
    return this.activeTabId ? this.views.get(this.activeTabId) : undefined;
  }

  private requireActiveTab() {
    const tab = this.requireActiveTabOrUndefined();
    if (!tab) {
      throw new Error("浏览器标签未打开");
    }

    return tab;
  }

  private requireActiveTabOrUndefined() {
    return this.activeTabId ? this.tabs.get(this.activeTabId) : undefined;
  }

  private requireTab(tabId: string) {
    const tab = this.tabs.get(tabId);
    if (!tab) {
      throw new Error("标签不存在");
    }

    return tab;
  }

  private requireActiveSiteSession() {
    const tab = this.requireActiveTab();
    if (!tab.siteId || !tab.sessionId) {
      throw new Error("当前标签不是站点会话");
    }

    return { siteId: tab.siteId, sessionId: tab.sessionId };
  }

  private resolveJarvisScriptRequestContext(input: { siteId?: string; sessionId?: string }) {
    const activeTab = this.requireActiveTabOrUndefined();
    const tab = input.siteId
      ? [...this.tabs.values()].find((candidate) =>
        candidate.siteId === input.siteId
        && (!input.sessionId || candidate.sessionId === input.sessionId),
      )
      : activeTab;
    const view = tab ? this.views.get(tab.id) : undefined;
    if (view && !view.webContents.isDestroyed()) {
      return {
        session: view.webContents.session,
        userAgent: view.webContents.getUserAgent(),
      };
    }

    if (tab?.siteId && tab.sessionId) {
      return {
        session: getElectronSession(tab.siteId, tab.sessionId),
      };
    }

    return {
      session: getDefaultProfileSession(),
      userAgent: this.window.webContents.getUserAgent(),
    };
  }

  private destroyView(viewKey: string, view: WebContentsView) {
    this.cleanupViewLifecycle(viewKey);
    this.viewRegistry.removeChildView(viewKey);

    try {
      if (!view.webContents.isDestroyed()) {
        view.webContents.close();
      }
    } catch {
      // Electron 退出时嵌入页可能已被销毁。
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

function titleForInternalPage(pageId: BrowserInternalPageId) {
  return {
    newtab: "新标签页",
    downloads: "下载记录",
    settings: "设置",
    extensions: "扩展程序管理",
    "jarvis-script": "jarvis-script",
    history: "历史记录",
    "clear-browsing-data": "删除浏览数据",
  }[pageId];
}


function toElectronCookieSetDetails(details: CookieSetDetails): Electron.CookiesSetDetails {
  return {
    url: details.url,
    name: details.name,
    value: details.value,
    domain: details.domain,
    path: details.path,
    secure: details.secure,
    httpOnly: details.httpOnly,
    expirationDate: details.expirationDate,
    sameSite: details.sameSite,
  };
}
