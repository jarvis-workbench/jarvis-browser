"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.BrowserHost = void 0;
const electron_1 = require("electron");
const node_path_1 = require("node:path");
const browser_bounds_1 = require("../browser-bounds");
const download_manager_1 = require("../download-manager");
const electron_session_manager_1 = require("../electron-session-manager");
const extension_runtime_1 = require("../extension-runtime");
const internal_protocol_1 = require("../internal-protocol");
const manager_1 = require("../jarvis-script/manager");
const runtime_1 = require("../jarvis-script/runtime");
const browser_overlay_host_1 = require("../browser-overlay-host");
const browser_overlay_menu_1 = require("../browser-overlay-menu");
const store_1 = require("../store");
const lifecycle_1 = require("./lifecycle");
const controller_1 = require("./monitor/controller");
const navigation_1 = require("./navigation");
const navigation_target_1 = require("./navigation-target");
const state_1 = require("./state");
const view_registry_1 = require("./view-registry");
const now = () => new Date().toISOString();
const createId = () => {
    if (globalThis.crypto?.randomUUID) {
        return globalThis.crypto.randomUUID();
    }
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
};
class BrowserHost {
    window;
    store;
    historyManager;
    views = new Map();
    tabs = new Map();
    viewStates = new Map();
    lifecycle = new lifecycle_1.ViewLifecycle();
    failedNavigationUrls = new Map();
    failedNavigationStatusCodes = new Map();
    externalNavigationUrls = new Map();
    responseStatusCodes = new Map();
    activeTabId;
    bounds = browser_bounds_1.defaultBrowserBounds;
    downloadManager;
    extensionRuntime;
    jarvisScriptRuntime;
    jarvisScriptManager;
    viewRegistry;
    browserOverlayHost;
    constructor(window, store, historyManager) {
        this.window = window;
        this.store = store;
        this.historyManager = historyManager;
        this.viewRegistry = new view_registry_1.ViewRegistry(window, this.views, () => this.bounds);
        this.browserOverlayHost = new browser_overlay_host_1.BrowserOverlayHost(window);
        this.downloadManager = new download_manager_1.DownloadManager(window, store);
        this.extensionRuntime = new extension_runtime_1.ExtensionRuntime(window, store, (key, targetSession) => {
            this.downloadManager.bindSession(key, targetSession);
        });
        this.jarvisScriptRuntime = new runtime_1.JarvisScriptRuntime({
            window,
            store,
            emitMetadataUpdate: () => this.emitMetadataUpdate(),
            emitBrowserState: (viewKey, errorText) => this.emitBrowserState(viewKey, errorText),
            isPageSuccessful: (viewKey, pageUrl) => this.isPageSuccessful(viewKey, pageUrl),
            sendMessageToWebContents: (input) => this.sendJarvisScriptMessageToWebContents(input),
        });
        this.jarvisScriptManager = new manager_1.JarvisScriptManager(window, store, this.jarvisScriptRuntime);
    }
    async open(siteId, sessionId) {
        await this.createSiteTab({ siteId, sessionId });
    }
    async createTab(input = {}) {
        const opener = input.openerTabId ? this.tabs.get(input.openerTabId) : undefined;
        const partition = opener?.partition ?? (0, electron_session_manager_1.createDefaultProfilePartition)();
        const targetSession = opener?.siteId && opener.sessionId
            ? (0, electron_session_manager_1.getElectronSession)(opener.siteId, opener.sessionId)
            : electron_1.session.fromPartition(partition);
        const navigationTarget = input.url ? (0, navigation_target_1.resolveNavigationTarget)(input.url) : undefined;
        if (navigationTarget?.kind === "external") {
            await this.openExternalTarget(navigationTarget);
            throw new Error("外部协议不在新标签页中打开");
        }
        if (navigationTarget?.kind === "blocked") {
            throw new Error(navigationTarget.errorText);
        }
        const url = navigationTarget?.url ?? internal_protocol_1.internalPageUrls.newtab;
        const kind = input.url ? "default" : "internal";
        const tab = this.createTabRecord({
            kind,
            url,
            title: kind === "internal" ? "新标签页" : "新标签",
            partition,
            siteId: opener?.siteId,
            sessionId: opener?.sessionId,
            openerTabId: input.openerTabId,
            internalPageId: kind === "internal" ? "newtab" : undefined,
        });
        if (tab.kind === "default") {
            await this.extensionRuntime.loadEnabledForDefaultProfile();
            await this.jarvisScriptRuntime.refreshUserScriptWorkers();
        }
        await this.createViewForTab(tab, targetSession);
        await this.activateTab(tab.id);
        await this.loadUrlSafely(url, this.views.get(tab.id), tab.id);
        this.emitTabsChanged();
        return structuredClone(tab);
    }
    async createSiteTab(input) {
        const site = this.store.getSite(input.siteId);
        const siteSession = this.store.getSession(input.siteId, input.sessionId);
        if (!site || !siteSession) {
            throw new Error("会话不存在");
        }
        const existing = [...this.tabs.values()].find((tab) => tab.kind === "site" && tab.siteId === input.siteId && tab.sessionId === input.sessionId);
        if (existing) {
            await this.activateTab(existing.id);
            return structuredClone(existing);
        }
        const partition = (0, electron_session_manager_1.createSessionPartition)(input.siteId, input.sessionId);
        const tab = this.createTabRecord({
            kind: "site",
            url: site.url,
            title: siteSession.name,
            favicon: site.faviconPath || site.faviconUrl,
            siteId: input.siteId,
            sessionId: input.sessionId,
            partition,
        });
        const targetSession = (0, electron_session_manager_1.getElectronSession)(input.siteId, input.sessionId);
        await this.createViewForTab(tab, targetSession);
        await this.extensionRuntime.loadEnabledForSite(site);
        await this.jarvisScriptRuntime.refreshUserScriptWorkers();
        await this.activateTab(tab.id);
        await this.loadUrlSafely((0, store_1.normalizeHttpUrl)(site.url), this.views.get(tab.id), tab.id);
        this.emitTabsChanged();
        return structuredClone(tab);
    }
    async openInternalPage(input) {
        const existing = [...this.tabs.values()].find((tab) => tab.kind === "internal" && tab.internalPageId === input.pageId);
        if (existing) {
            await this.activateTab(existing.id);
            return structuredClone(existing);
        }
        const url = internal_protocol_1.internalPageUrls[input.pageId];
        const tab = this.createTabRecord({
            kind: "internal",
            url,
            title: titleForInternalPage(input.pageId),
            partition: (0, electron_session_manager_1.createDefaultProfilePartition)(),
            internalPageId: input.pageId,
        });
        await this.createViewForTab(tab, (0, electron_session_manager_1.getDefaultProfileSession)());
        await this.activateTab(tab.id);
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
    async activateTab(tabId) {
        const tab = this.tabs.get(tabId);
        if (!tab) {
            throw new Error("标签不存在");
        }
        this.browserOverlayHost.closeOverlay();
        this.activeTabId = tab.id;
        this.viewRegistry.activate(tab.id);
        this.emitBrowserState(tab.id);
        this.emitTabsChanged();
    }
    async closeTab(tabId) {
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
                await this.activateTab(nextTab.id);
            }
            else {
                await this.openInternalPage({ pageId: "newtab" });
                return;
            }
        }
        this.emitTabsChanged();
    }
    async navigateTab(tabId, url) {
        const tab = this.requireTab(tabId);
        const previousUrl = tab.url;
        const previousTitle = tab.title;
        const target = (0, navigation_target_1.resolveNavigationTarget)(url);
        if (target.kind === "external") {
            await this.openExternalTarget(target, tabId);
            this.emitBrowserState(tabId);
            this.emitTabsChanged();
            return (0, navigation_target_1.toNavigationResult)(target);
        }
        if (target.kind === "blocked") {
            await this.loadErrorPage(target.url, target.errorText, this.views.get(tabId), tabId);
            return (0, navigation_target_1.toNavigationResult)(target);
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
        return (0, navigation_target_1.toNavigationResult)(target);
    }
    async navigate(url) {
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
    reload() {
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
            webContents.openDevTools({
                activate: false,
            });
        }
        catch (error) {
            webContents.removeListener("devtools-opened", restoreMainWindowFocus);
            throw error;
        }
    }
    async reloadErrorPage() {
        const tab = this.requireActiveTab();
        const targetUrl = this.failedNavigationUrls.get(tab.id);
        if (!targetUrl) {
            this.reload();
            return;
        }
        this.failedNavigationStatusCodes.delete(tab.id);
        this.responseStatusCodes.delete(tab.id);
        await this.loadUrlSafely(targetUrl, this.getActiveView(), tab.id);
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
    setBounds(rect) {
        this.bounds = (0, browser_bounds_1.clampBrowserBounds)(rect);
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
        this.activeTabId = undefined;
        this.viewRegistry.setMountedViewKey(undefined);
        this.jarvisScriptRuntime.close();
    }
    async closeSession(siteId, sessionId) {
        const matchingTabs = [...this.tabs.values()].filter((tab) => tab.siteId === siteId && tab.sessionId === sessionId);
        for (const tab of matchingTabs) {
            await this.closeTab(tab.id);
        }
    }
    getActiveSiteId() {
        return this.requireActiveTabOrUndefined()?.siteId;
    }
    isActiveSession(siteId, sessionId) {
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
    async installGlobalUnpacked() {
        return this.extensionRuntime.installGlobalUnpacked();
    }
    async installSiteUnpacked(siteId) {
        return this.extensionRuntime.installSiteUnpacked(siteId);
    }
    async enableGlobalExtension(extensionId) {
        return this.extensionRuntime.enableGlobal(extensionId);
    }
    async disableGlobalExtension(extensionId) {
        this.browserOverlayHost.closeOverlay();
        return this.extensionRuntime.disableGlobal(extensionId);
    }
    async uninstallGlobalExtension(extensionId) {
        this.browserOverlayHost.closeOverlay();
        await this.extensionRuntime.uninstallGlobal(extensionId);
    }
    async enableSiteExtension(siteId, extensionId) {
        return this.extensionRuntime.enableSite(siteId, extensionId);
    }
    async disableSiteExtension(siteId, extensionId) {
        this.browserOverlayHost.closeOverlay();
        return this.extensionRuntime.disableSite(siteId, extensionId);
    }
    async uninstallSiteExtension(siteId, extensionId) {
        this.browserOverlayHost.closeOverlay();
        await this.extensionRuntime.uninstallSite(siteId, extensionId);
    }
    async openExtensionPopup(input) {
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
        const targetSession = (0, electron_session_manager_1.getElectronSession)(input.siteId, input.sessionId);
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
                preload: (0, node_path_1.join)(__dirname, "../../preload/extension-popup-preload.js"),
                contextIsolation: true,
                nodeIntegration: false,
                sandbox: true,
            },
        });
        await popupWindow.loadURL(popupUrl.toString()).catch((error) => {
            this.browserOverlayHost.closeOverlay();
            throw error;
        });
    }
    closeExtensionPopup() {
        this.browserOverlayHost.closeOverlay();
    }
    async openExtensionMenu(input) {
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
            items: (0, browser_overlay_menu_1.createExtensionMenuItems)({
                extensions,
                canInstallSiteExtension: Boolean(site),
            }),
            emptyText: "当前没有可弹出的扩展",
        });
    }
    async openDownloadsBubble(input) {
        const downloads = this.store.listDownloads();
        await this.openToolMenuOverlay({
            key: "downloads-bubble",
            title: "下载内容",
            subtitle: downloads.some((download) => download.state === "progressing") ? "正在下载" : "最近下载",
            anchor: input.anchor,
            width: 320,
            items: (0, browser_overlay_menu_1.createDownloadMenuItems)(downloads),
            emptyText: "暂无下载记录",
        });
    }
    async openAppMenu(input) {
        await this.openToolMenuOverlay({
            key: "app-menu",
            title: "更多",
            anchor: input.anchor,
            width: 240,
            items: (0, browser_overlay_menu_1.createAppMenuItems)(),
        });
    }
    closeOverlay() {
        this.browserOverlayHost.closeOverlay();
    }
    async openToolMenuOverlay(input) {
        await this.browserOverlayHost.openToolOverlay({
            key: input.key,
            anchor: input.anchor,
            width: input.width,
            height: (0, browser_overlay_menu_1.getToolOverlayHeight)(input),
            url: browser_overlay_menu_1.toolOverlayUrl,
            data: {
                title: input.title,
                subtitle: input.subtitle,
                anchor: input.anchor,
                items: input.items,
                emptyText: input.emptyText,
            },
        });
    }
    async handleOverlayAction(input) {
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
        if (input.action === "clear-browsing-data") {
            await this.openInternalPage({ pageId: "clear-browsing-data" });
            return;
        }
        if (input.action === "jarvis-script") {
            await this.openInternalPage({ pageId: "jarvis-script" });
        }
    }
    async setActiveSessionCookie(details) {
        const active = this.requireActiveSiteSession();
        const targetSession = (0, electron_session_manager_1.getElectronSession)(active.siteId, active.sessionId);
        await targetSession.cookies.set(toElectronCookieSetDetails(details));
    }
    async removeActiveSessionCookie(details) {
        const active = this.requireActiveSiteSession();
        const targetSession = (0, electron_session_manager_1.getElectronSession)(active.siteId, active.sessionId);
        await targetSession.cookies.remove(details.url, details.name);
    }
    listGlobalJarvisScripts() {
        return this.jarvisScriptRuntime.listGlobalRuntimeStates();
    }
    listSiteJarvisScripts(siteId) {
        return this.jarvisScriptRuntime.listSiteRuntimeStates(siteId);
    }
    async installGlobalJarvisScript() {
        return this.jarvisScriptManager.installGlobal();
    }
    async installSiteJarvisScript(siteId) {
        return this.jarvisScriptManager.installSite(siteId);
    }
    async enableGlobalJarvisScript(scriptId) {
        return this.jarvisScriptManager.enableGlobal(scriptId);
    }
    async disableGlobalJarvisScript(scriptId) {
        return this.jarvisScriptManager.disableGlobal(scriptId);
    }
    async uninstallGlobalJarvisScript(scriptId) {
        await this.jarvisScriptManager.uninstallGlobal(scriptId);
    }
    async enableSiteJarvisScript(siteId, scriptId) {
        return this.jarvisScriptManager.enableSite(siteId, scriptId);
    }
    async disableSiteJarvisScript(siteId, scriptId) {
        return this.jarvisScriptManager.disableSite(siteId, scriptId);
    }
    async uninstallSiteJarvisScript(siteId, scriptId) {
        await this.jarvisScriptManager.uninstallSite(siteId, scriptId);
    }
    bindDefaultDownloads() {
        this.downloadManager.bindDefault();
        this.downloadManager.bindSession((0, electron_session_manager_1.createDefaultProfilePartition)(), (0, electron_session_manager_1.getDefaultProfileSession)());
    }
    pauseDownload(downloadId) {
        return this.downloadManager.pause(downloadId);
    }
    resumeDownload(downloadId) {
        return this.downloadManager.resume(downloadId);
    }
    cancelDownload(downloadId) {
        return this.downloadManager.cancel(downloadId);
    }
    openDownload(downloadId) {
        return this.downloadManager.open(downloadId);
    }
    showDownloadInFolder(downloadId) {
        return this.downloadManager.showInFolder(downloadId);
    }
    handleBrowserShortcut(input) {
        if ((0, navigation_1.isBrowserReloadShortcut)(input)) {
            try {
                this.reload();
            }
            catch {
                // 没有激活标签时忽略浏览器刷新快捷键。
            }
            return true;
        }
        if ((0, navigation_1.isBrowserDevToolsShortcut)(input)) {
            try {
                this.openDevTools();
            }
            catch {
                // 没有激活标签时不打开 renderer 开发者工具。
            }
            return true;
        }
        return false;
    }
    createTabRecord(input) {
        const timestamp = now();
        const tab = {
            id: createId(),
            kind: input.kind,
            url: input.url,
            title: input.title,
            favicon: input.favicon,
            siteId: input.siteId,
            sessionId: input.sessionId,
            partition: input.partition,
            openerTabId: input.openerTabId,
            internalPageId: input.internalPageId,
            pinnedExtensionIds: [],
            createdAt: timestamp,
            updatedAt: timestamp,
        };
        this.tabs.set(tab.id, tab);
        return tab;
    }
    async createViewForTab(tab, targetSession) {
        (0, internal_protocol_1.registerInternalProtocolForSession)(targetSession);
        this.downloadManager.bindSession(tab.id, targetSession);
        const view = new electron_1.WebContentsView({
            webPreferences: {
                session: targetSession,
                preload: tab.kind === "internal"
                    ? (0, node_path_1.join)(__dirname, "../../preload/preload.js")
                    : (0, node_path_1.join)(__dirname, "../../preload/web-page-preload.js"),
                contextIsolation: true,
                nodeIntegration: false,
                sandbox: tab.kind !== "internal",
            },
        });
        this.views.set(tab.id, view);
        this.lifecycle.markOpen(tab.id);
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
    bindNavigationEvents(view, tabId) {
        const webContents = view.webContents;
        webContents.session.webRequest.onCompleted({ urls: ["http://*/*", "https://*/*"] }, (details) => {
            if (!this.isViewAlive(tabId, webContents)) {
                return;
            }
            if (details.webContentsId === webContents.id && details.resourceType === "mainFrame" && details.statusCode >= 400) {
                this.responseStatusCodes.set(tabId, details.statusCode);
                void this.handleHttpStatusPage(tabId, details.url, details.statusCode);
            }
        });
        webContents.setWindowOpenHandler(({ url }) => {
            if (!this.isViewAlive(tabId, webContents)) {
                return { action: "deny" };
            }
            const target = (0, navigation_target_1.resolveNavigationTarget)(url);
            if (target.kind === "browser") {
                void this.createTab({ url: target.url, openerTabId: tabId });
            }
            else if (target.kind === "external") {
                void this.openExternalTarget(target, tabId);
            }
            else {
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
            if (this.isViewAlive(tabId, webContents)
                && isMainFrame
                && errorCode !== -3
                && validatedUrl !== this.externalNavigationUrls.get(tabId)) {
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
            if (tab && !(0, internal_protocol_1.isInternalErrorPageUrl)(webContents.getURL())) {
                tab.title = this.resolveCanonicalTabTitle(tab, title);
                tab.updatedAt = now();
            }
            this.emitBrowserState(tabId);
            this.emitTabsChanged();
        });
    }
    handleNavigation(tabId, url) {
        const view = this.views.get(tabId);
        if (!view || !this.isViewAlive(tabId, view.webContents)) {
            return;
        }
        if ((0, internal_protocol_1.isInternalErrorPageUrl)(url)) {
            this.emitBrowserState(tabId);
            return;
        }
        this.failedNavigationUrls.delete(tabId);
        this.failedNavigationStatusCodes.delete(tabId);
        this.externalNavigationUrls.delete(tabId);
        this.responseStatusCodes.delete(tabId);
        const tab = this.tabs.get(tabId);
        if (tab) {
            const canonicalUrl = this.resolveCanonicalTabUrl(tab, url);
            tab.url = canonicalUrl;
            tab.title = this.resolveCanonicalTabTitle(tab, view.webContents.getTitle());
            tab.updatedAt = now();
            if (tab.kind !== "internal") {
                this.recordHistoryNavigation(tab, canonicalUrl, view.webContents.getTitle());
            }
        }
        this.emitBrowserState(tabId);
        this.emitTabsChanged();
    }
    resolveCanonicalTabUrl(tab, navigatedUrl) {
        if (tab.kind === "internal") {
            return tab.internalPageId ? internal_protocol_1.internalPageUrls[tab.internalPageId] : tab.url;
        }
        return (0, internal_protocol_1.isInternalPageUrl)(navigatedUrl) ? tab.url : navigatedUrl;
    }
    resolveCanonicalTabTitle(tab, pageTitle) {
        if (tab.kind === "internal" && tab.internalPageId) {
            return titleForInternalPage(tab.internalPageId);
        }
        return pageTitle || tab.title;
    }
    emitBrowserStateIfAlive(tabId, webContents) {
        if (this.isViewAlive(tabId, webContents)) {
            this.emitBrowserState(tabId);
        }
    }
    async handleMainFrameNavigationEvent(event, tabId, url, isMainFrame) {
        if (!isMainFrame) {
            return;
        }
        const target = (0, navigation_target_1.resolveNavigationTarget)(url);
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
    async handleHttpStatusPage(tabId, url, statusCode) {
        if ((0, internal_protocol_1.isInternalErrorPageUrl)(url) || statusCode < 400) {
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
        const bodyText = await view.webContents.executeJavaScript("document.body ? document.body.innerText.trim() : ''", true).catch(() => "");
        if (bodyText) {
            this.emitBrowserState(tabId, `HTTP ${statusCode}`);
            return;
        }
        await this.showHttpErrorPage(tabId, url, statusCode);
    }
    async showHttpErrorPage(tabId, url, statusCode) {
        const view = this.views.get(tabId);
        if (!view || view.webContents.isDestroyed()) {
            return;
        }
        this.failedNavigationUrls.set(tabId, url);
        this.failedNavigationStatusCodes.set(tabId, statusCode);
        this.responseStatusCodes.delete(tabId);
        await view.webContents.loadURL((0, internal_protocol_1.createInternalErrorPageUrl)({
            kind: "http",
            url,
            statusCode,
            errorText: `请求失败，状态码：${statusCode}`,
        }));
        this.emitBrowserState(tabId, `HTTP ${statusCode}`);
    }
    bindMonitor(view, viewKey, siteId, sessionId) {
        const monitor = new controller_1.JarvisMonitorController({
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
    recordHistoryNavigation(tab, url, title) {
        void this.historyManager.recordNavigation({
            tabId: tab.id,
            siteId: tab.siteId,
            sessionId: tab.sessionId,
            partition: tab.partition,
            url,
            title,
        }).catch((error) => {
            console.error(`[history] ${tab.id} 导航记录失败`, error);
        });
    }
    async sendJarvisScriptMessageToWebContents(input) {
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
            await view.webContents.executeJavaScript(`window.dispatchEvent(new MessageEvent('message', { data: ${message} }))`, true).catch((error) => {
                console.error(`[jarvis-script] ${viewKey} 扩展程序消息投递失败`, error);
            });
        }
    }
    resolveMessageTargetViewKeys(siteId, sessionId) {
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
    isPageSuccessful(viewKey, currentUrl) {
        return Boolean(currentUrl)
            && !(0, internal_protocol_1.isInternalErrorPageUrl)(currentUrl)
            && !this.failedNavigationUrls.has(viewKey)
            && !this.failedNavigationStatusCodes.has(viewKey)
            && !this.responseStatusCodes.has(viewKey);
    }
    isViewAlive(viewKey, webContents) {
        if (this.lifecycle.isClosing(viewKey)) {
            return false;
        }
        const view = this.views.get(viewKey);
        if (!view || view.webContents.isDestroyed()) {
            return false;
        }
        return !webContents || view.webContents === webContents;
    }
    runViewTask(viewKey, task) {
        task.catch((error) => {
            if (!this.isViewAlive(viewKey)) {
                return;
            }
            console.error(`[browser] ${viewKey} 异步任务失败`, error);
        });
    }
    cleanupViewLifecycle(viewKey) {
        this.lifecycle.cleanup(viewKey);
        this.failedNavigationUrls.delete(viewKey);
        this.failedNavigationStatusCodes.delete(viewKey);
        this.externalNavigationUrls.delete(viewKey);
        this.responseStatusCodes.delete(viewKey);
    }
    async loadUrlSafely(url, view = this.getActiveViewOrUndefined(), viewKey = this.activeTabId) {
        if (!view || view.webContents.isDestroyed()) {
            return;
        }
        const target = (0, navigation_target_1.resolveNavigationTarget)(url);
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
        }
        catch (error) {
            if ((0, navigation_1.isNavigationAbort)(error)) {
                return;
            }
            await this.loadErrorPage(target.url, (0, navigation_1.formatNavigationError)(error), view, viewKey);
        }
    }
    async loadMainFrameErrorPage(viewKey, url, errorText) {
        if ((0, internal_protocol_1.isInternalErrorPageUrl)(url)) {
            return;
        }
        const view = this.views.get(viewKey);
        if (!view || view.webContents.isDestroyed()) {
            return;
        }
        await this.loadErrorPage(url || this.failedNavigationUrls.get(viewKey) || view.webContents.getURL(), errorText, view, viewKey);
    }
    async loadErrorPage(url, errorText, view = this.getActiveViewOrUndefined(), viewKey = this.activeTabId) {
        if (!view || view.webContents.isDestroyed()) {
            return;
        }
        if (viewKey) {
            this.failedNavigationUrls.set(viewKey, url);
            this.failedNavigationStatusCodes.delete(viewKey);
            this.externalNavigationUrls.delete(viewKey);
            this.responseStatusCodes.delete(viewKey);
        }
        await view.webContents.loadURL((0, internal_protocol_1.createInternalErrorPageUrl)({
            kind: "network",
            url,
            errorText,
        })).catch(() => undefined);
        this.emitBrowserState(viewKey, `${errorText}：${url}`);
    }
    emitBrowserState(viewKey = this.activeTabId, errorText) {
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
            }
            : {};
        const nextState = this.updateViewState(viewKey, view, {
            ...tabPatch,
            errorText,
        });
        this.window.webContents.send("browser:state-changed", nextState);
    }
    updateViewState(viewKey, view, patch) {
        const displayUrl = viewKey ? this.failedNavigationUrls.get(viewKey) : undefined;
        const statusCode = viewKey ? this.failedNavigationStatusCodes.get(viewKey) : undefined;
        const nextState = (0, state_1.createBrowserState)({
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
    async openExternalTarget(target, viewKey) {
        try {
            await electron_1.shell.openExternal(target.url);
            if (viewKey) {
                this.externalNavigationUrls.set(viewKey, target.url);
                this.failedNavigationUrls.delete(viewKey);
                this.failedNavigationStatusCodes.delete(viewKey);
                this.responseStatusCodes.delete(viewKey);
            }
        }
        catch (error) {
            await this.loadErrorPage(target.url, `外部协议无法打开：${(0, navigation_1.formatNavigationError)(error)}`, viewKey ? this.views.get(viewKey) : undefined, viewKey);
        }
    }
    emitTabsChanged() {
        if (this.window.isDestroyed() || this.window.webContents.isDestroyed()) {
            return;
        }
        this.window.webContents.send("browser:tabs-changed", this.listTabs());
    }
    emitMetadataUpdate() {
        if (this.window.isDestroyed() || this.window.webContents.isDestroyed()) {
            return;
        }
        const sites = this.store.listSites();
        this.syncSiteTabMetadata(sites);
        this.window.webContents.send("site:metadata-updated", sites);
        this.emitTabsChanged();
    }
    syncSiteTabMetadata(sites = this.store.listSites()) {
        const sitesById = new Map(sites.map((site) => [site.id, site]));
        for (const tab of this.tabs.values()) {
            if (tab.kind !== "site" || !tab.siteId) {
                continue;
            }
            const site = sitesById.get(tab.siteId);
            if (!site) {
                continue;
            }
            const favicon = site.faviconPath || site.faviconUrl;
            tab.favicon = favicon || undefined;
            tab.updatedAt = now();
            const state = this.viewStates.get(tab.id);
            if (state) {
                this.viewStates.set(tab.id, {
                    ...state,
                    favicon: tab.favicon,
                });
            }
        }
    }
    getActiveView() {
        const view = this.getActiveViewOrUndefined();
        if (!view) {
            throw new Error("浏览器标签未打开");
        }
        return view;
    }
    getActiveViewOrUndefined() {
        return this.activeTabId ? this.views.get(this.activeTabId) : undefined;
    }
    requireActiveTab() {
        const tab = this.requireActiveTabOrUndefined();
        if (!tab) {
            throw new Error("浏览器标签未打开");
        }
        return tab;
    }
    requireActiveTabOrUndefined() {
        return this.activeTabId ? this.tabs.get(this.activeTabId) : undefined;
    }
    requireTab(tabId) {
        const tab = this.tabs.get(tabId);
        if (!tab) {
            throw new Error("标签不存在");
        }
        return tab;
    }
    requireActiveSiteSession() {
        const tab = this.requireActiveTab();
        if (!tab.siteId || !tab.sessionId) {
            throw new Error("当前标签不是站点会话");
        }
        return { siteId: tab.siteId, sessionId: tab.sessionId };
    }
    destroyView(viewKey, view) {
        this.cleanupViewLifecycle(viewKey);
        this.viewRegistry.removeChildView(viewKey);
        try {
            if (!view.webContents.isDestroyed()) {
                view.webContents.close();
            }
        }
        catch {
            // Electron 退出时嵌入页可能已被销毁。
        }
    }
    async flushViewSession(view) {
        if (view.webContents.isDestroyed()) {
            return;
        }
        await (0, electron_session_manager_1.flushElectronSession)(view.webContents.session);
    }
    unmountActiveView() {
        this.viewRegistry.unmountActiveView();
    }
}
exports.BrowserHost = BrowserHost;
function titleForInternalPage(pageId) {
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
function toElectronCookieSetDetails(details) {
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
