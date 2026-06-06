import { defineStore } from 'pinia';
import { computed, nextTick, ref } from 'vue';
import type { AppUpdateStatus, BrowserInternalPageId, BrowserRect, BrowserState, BrowserTab, DownloadSettings, DownloadState, OpenSessionSyncDialogInput, SessionSyncApplyImportInput, SessionSyncExportInput, SessionSyncPreviewImportInput, Site, SiteExtension, SiteSession } from '../../shared/types';
import { useBrowserExtensions } from './browser-extensions';
import { useBrowserScripts } from './browser-scripts';
import { downloadsTabId, homeTabId, settingsTabId, type InternalPageTabId, useBrowserTabs } from './browser-tabs';
import { formatError, needsHttpsPrefix } from '../../shared/utils';

const fallbackBrowserState: BrowserState = {
  url: '',
  title: '',
  canGoBack: false,
  canGoForward: false,
  isLoading: false,
};

export const useBrowserStore = defineStore('browser', () => {
  const sites = ref<Site[]>([]);
  const browserState = ref<BrowserState>({ ...fallbackBrowserState });
  const address = ref('');
  const loading = ref(false);
  const statusMessage = ref('准备就绪');
  const downloads = ref<DownloadState[]>([]);
  const downloadSettings = ref<DownloadSettings | null>(null);
  const appUpdateStatus = ref<AppUpdateStatus>({
    phase: 'idle',
    currentVersion: '',
    isPackaged: false,
    platform: '',
    updatedAt: '',
  });
  const lastDownloadUpdatedAt = ref(0);
  const unacknowledgedDownloadCount = ref(0);
  const sessionSyncDialog = ref<OpenSessionSyncDialogInput & { visible: boolean }>({
    visible: false,
    scope: 'global',
  });
  const sessionSyncHadEmbeddedView = ref(false);
  const lastBrowserBounds = ref<BrowserRect | null>(null);
  let pendingBounds: { element: HTMLElement; insetLeft: number; insetRight: number } | undefined;
  let boundsFrame: number | undefined;

  const tabs = useBrowserTabs(sites);
  const selectedSite = tabs.selectedSite;
  const extensions = useBrowserExtensions({
    selectedSite,
    patchSite,
    setStatusMessage: (message) => {
      statusMessage.value = message;
    },
  });
  const scripts = useBrowserScripts({
    selectedSite,
    patchSite,
    setStatusMessage: (message) => {
      statusMessage.value = message;
    },
  });

  async function loadSites() {
    loading.value = true;
    try {
      sites.value = await window.appApi.sites.list();
      statusMessage.value = '站点已加载';
    } catch (error) {
      statusMessage.value = `站点加载失败：${formatError(error)}`;
    } finally {
      loading.value = false;
    }
  }

  async function loadDownloads() {
    downloads.value = await window.appApi.downloads.list();
  }

  async function loadSettings() {
    downloadSettings.value = await window.appApi.settings.get();
  }

  async function loadUpdateStatus() {
    appUpdateStatus.value = await window.appApi.updates.getStatus();
  }

  async function addSite(rawUrl: string) {
    const url = rawUrl.trim();
    if (!url) {
      return undefined;
    }

    const site = await window.appApi.sites.add({ url: normalizeUrl(url) });
    sites.value = [...sites.value, site];
    statusMessage.value = `已添加 ${siteDisplayTitle(site)}`;
    return site;
  }

  async function deleteSite(site: Site) {
    await window.appApi.sites.delete(site.id);
    sites.value = sites.value.filter((item) => item.id !== site.id);
    statusMessage.value = '站点已移除';
  }

  async function updateSite(site: Site, input: { title?: string; url?: string }) {
    const updated = await window.appApi.sites.update(site.id, input);
    patchSite(site.id, updated);
    if (tabs.selectedSiteId.value === site.id && input.url !== undefined) {
      address.value = updated.url;
      browserState.value = { ...browserState.value, url: updated.url };
    }
    statusMessage.value = '站点已保存';
    return updated;
  }

  async function reorderSites(siteIds: string[]) {
    const nextSites = await window.appApi.sites.reorder(siteIds);
    sites.value = nextSites;
    statusMessage.value = '站点顺序已更新';
    return nextSites;
  }

  function previewSiteOrder(siteIds: string[]) {
    const requestedSet = new Set(siteIds);
    const requestedSites = siteIds
      .map((siteId) => sites.value.find((site) => site.id === siteId))
      .filter((site): site is Site => Boolean(site));
    sites.value = [
      ...requestedSites,
      ...sites.value.filter((site) => !requestedSet.has(site.id)),
    ];
  }

  async function openSite(siteId: string, sessionId?: string) {
    const site = sites.value.find((item) => item.id === siteId);
    if (!site) {
      statusMessage.value = '站点不存在';
      return;
    }

    const session = site.sessions.find((item) => item.id === sessionId) ?? site.sessions[0] ?? null;
    if (session) {
      await openSession(site, session);
    } else {
      address.value = site.url;
      browserState.value = { ...fallbackBrowserState, url: site.url };
    }
  }

  async function addSession(name?: string) {
    if (!selectedSite.value) {
      return undefined;
    }

    const sessionName = name?.trim() || nextSessionName(selectedSite.value);
    assertUniqueSessionName(selectedSite.value, sessionName);
    const site = selectedSite.value;
    const session = await window.appApi.sessions.add(site.id, { name: sessionName });
    patchSite(site.id, {
      sessions: [...site.sessions, session],
    });
    await openSession({ ...site, sessions: [...site.sessions, session] }, session);
    return session;
  }

  async function addSessionToSite(site: Site, name?: string) {
    const sessionName = name?.trim() || nextSessionName(site);
    assertUniqueSessionName(site, sessionName);
    const session = await window.appApi.sessions.add(site.id, { name: sessionName });
    patchSite(site.id, {
      sessions: [...site.sessions, session],
    });
    return session;
  }

  async function openSession(site: Site, session: SiteSession) {
    const tab = await window.appApi.browser.createSiteTab({ siteId: site.id, sessionId: session.id });
    address.value = tab.url || site.url;
    statusMessage.value = `${session.name} 已打开`;
  }

  async function closeSessionTab(site: Site, session: SiteSession) {
    const tab = tabs.findSessionTab(site.id, session.id);
    if (!tab) {
      return;
    }

    await window.appApi.browser.closeTab(tab.id);
    tabs.removeTabState(tab.id);
  }

  async function activateHome() {
    await showHome();
  }

  async function activateInternalPage(pageId: InternalPageTabId) {
    await window.appApi.browser.openInternalPage({ pageId });
    if (pageId === downloadsTabId) {
      await loadDownloads();
      acknowledgeDownloads();
      statusMessage.value = '下载内容';
    } else if (pageId === settingsTabId) {
      await loadSettings();
      await loadUpdateStatus();
      statusMessage.value = '设置';
    } else {
      statusMessage.value = internalPageStatus(pageId);
    }
  }

  async function closeInternalPage(pageId: InternalPageTabId) {
    const tab = tabs.openTabs.value.find((item) => item.kind === 'internal' && item.internalPageId === pageId);
    if (tab) {
      await window.appApi.browser.closeTab(tab.id);
      tabs.removeTabState(tab.id);
    }
  }

  async function showHome() {
    await window.appApi.browser.showHome();
    extensions.clearSiteExtensions();
    scripts.clearSiteScripts();
    address.value = '';
    browserState.value = { ...fallbackBrowserState, title: '起始页' };
    statusMessage.value = '起始页';
  }

  async function activateOpenTab(tab: BrowserTab | { site: Site; session: SiteSession }) {
    if ('site' in tab) {
      await openSession(tab.site, tab.session);
      return;
    }

    await window.appApi.browser.activateTab(tab.id);
  }

  async function openSessionFromCurrentSite(session: SiteSession) {
    if (!selectedSite.value) {
      return;
    }

    await openSession(selectedSite.value, session);
  }

  async function openSessionFromSite(site: Site, session: SiteSession) {
    await openSession(site, session);
  }

  async function renameSession(session: SiteSession, name: string) {
    const site = sites.value.find((item) => item.sessions.some((siteSession) => siteSession.id === session.id));
    if (!site) {
      return;
    }

    const updated = await window.appApi.sessions.rename(site.id, session.id, name);
    patchSession(site.id, updated);
    statusMessage.value = '会话已重命名';
  }

  async function clearSessionData(session: SiteSession) {
    const site = sites.value.find((item) => item.sessions.some((siteSession) => siteSession.id === session.id));
    if (!site) {
      return;
    }

    await window.appApi.sessions.clearData(site.id, session.id, {
      cookies: true,
      cache: true,
      storage: true,
    });
    statusMessage.value = `${session.name} 数据已清空`;
  }

  async function deleteSession(session: SiteSession) {
    const site = sites.value.find((item) => item.sessions.some((siteSession) => siteSession.id === session.id));
    if (!site) {
      return;
    }

    await window.appApi.sessions.delete(site.id, session.id);
    tabs.removeSessionTabStates(site.id, session.id);
    const remaining = site.sessions.filter((item) => item.id !== session.id);
    patchSite(site.id, { sessions: remaining });

    if (tabs.selectedSessionId.value === session.id) {
      const nextSession = remaining[0] ?? null;
      address.value = site.url;
      if (nextSession) {
        await openSession({ ...site, sessions: remaining }, nextSession);
      } else {
        await showHome();
      }
    }
    statusMessage.value = '会话已移除';
  }

  async function navigate() {
    if (!tabs.selectedTab.value || !address.value.trim()) {
      return;
    }

    const nextUrl = normalizeUrl(address.value);
    address.value = nextUrl;
    browserState.value = { ...browserState.value, url: nextUrl, isLoading: true };
    const result = await window.appApi.browser.navigateTab(tabs.selectedTab.value.id, nextUrl);
    if (result.kind === 'loaded') {
      statusMessage.value = `正在访问 ${result.url}`;
      return;
    }

    if (result.kind === 'external-opened') {
      address.value = browserState.value.displayUrl || browserState.value.url || tabs.selectedTab.value.url;
      statusMessage.value = `已交给系统打开：${result.url}`;
      return;
    }

    statusMessage.value = `页面加载失败：${result.errorText}`;
  }

  async function browserAction(action: 'back' | 'forward' | 'reload' | 'stop') {
    await window.appApi.browser[action]();
  }

  async function hideEmbeddedView() {
    await window.appApi.browser.hideEmbeddedView();
  }

  async function showActiveView() {
    await window.appApi.browser.showActiveView();
  }

  async function pauseDownload(download: DownloadState) {
    patchDownload(await window.appApi.downloads.pause(download.id));
  }

  async function resumeDownload(download: DownloadState) {
    patchDownload(await window.appApi.downloads.resume(download.id));
  }

  async function cancelDownload(download: DownloadState) {
    patchDownload(await window.appApi.downloads.cancel(download.id));
  }

  async function openDownload(download: DownloadState) {
    await window.appApi.downloads.open(download.id);
  }

  async function showDownloadInFolder(download: DownloadState) {
    await window.appApi.downloads.showInFolder(download.id);
  }

  async function removeDownload(download: DownloadState) {
    await window.appApi.downloads.remove(download.id);
    downloads.value = downloads.value.filter((item) => item.id !== download.id);
  }

  async function clearDownloads() {
    await window.appApi.downloads.clear();
    downloads.value = [];
  }

  async function updateDownloadSettings(input: Partial<DownloadSettings>) {
    downloadSettings.value = await window.appApi.settings.update(input);
    return downloadSettings.value;
  }

  async function checkForUpdates() {
    appUpdateStatus.value = await window.appApi.updates.checkForUpdates();
    statusMessage.value = updateStatusMessage(appUpdateStatus.value);
    return appUpdateStatus.value;
  }

  async function downloadUpdate() {
    appUpdateStatus.value = await window.appApi.updates.downloadUpdate();
    statusMessage.value = updateStatusMessage(appUpdateStatus.value);
    return appUpdateStatus.value;
  }

  async function quitAndInstallUpdate() {
    appUpdateStatus.value = await window.appApi.updates.quitAndInstall();
    statusMessage.value = '正在重启安装更新';
    return appUpdateStatus.value;
  }

  async function openExtensionPopup(extension: SiteExtension, anchor: BrowserRect) {
    if (!selectedSite.value || !tabs.selectedSession.value) {
      throw new Error('请选择会话');
    }

    await window.appApi.extensions.openPopup({
      siteId: selectedSite.value.id,
      sessionId: tabs.selectedSession.value.id,
      extensionId: extension.id,
      anchor,
    });
    statusMessage.value = `${extension.action?.defaultTitle || extension.name} 面板已打开`;
  }

  async function closeExtensionPopup() {
    await window.appApi.extensions.closePopup();
  }

  async function selectDownloadPath() {
    const downloadPath = await window.appApi.settings.selectDownloadPath();
    if (!downloadPath) {
      return undefined;
    }

    return updateDownloadSettings({ downloadPath });
  }

  async function openSessionSyncDialog(input: OpenSessionSyncDialogInput) {
    sessionSyncHadEmbeddedView.value = Boolean(input.hideActiveView && tabs.selectedTab.value);
    if (sessionSyncHadEmbeddedView.value) {
      await hideEmbeddedView();
    }
    sessionSyncDialog.value = {
      visible: true,
      scope: input.scope,
      siteId: input.siteId,
    };
  }

  async function closeSessionSyncDialog() {
    sessionSyncDialog.value = {
      ...sessionSyncDialog.value,
      visible: false,
    };
    if (sessionSyncHadEmbeddedView.value) {
      sessionSyncHadEmbeddedView.value = false;
      await showActiveView();
    }
  }

  async function exportSessionSync(input: SessionSyncExportInput) {
    return window.appApi.sessionSync.export(input);
  }

  async function previewSessionSyncImport(input: SessionSyncPreviewImportInput) {
    return window.appApi.sessionSync.previewImport(input);
  }

  async function applySessionSyncImport(input: SessionSyncApplyImportInput) {
    const result = await window.appApi.sessionSync.applyImport(input);
    await loadSites();
    statusMessage.value = '登录状态已导入';
    return result;
  }

  async function cancelSessionSyncImport(importId: string) {
    await window.appApi.sessionSync.cancelImport(importId);
  }

  async function setBrowserBounds(element: HTMLElement | null, insetLeft = 0, insetRight = 0) {
    if (!element || !tabs.selectedTab.value) {
      return;
    }

    const bounds = resolveBrowserBounds(element, insetLeft, insetRight);
    if (sameBounds(lastBrowserBounds.value, bounds)) {
      return;
    }

    lastBrowserBounds.value = bounds;
    await window.appApi.browser.setBounds(bounds);
  }

  function scheduleBrowserBounds(element: HTMLElement | null, insetLeft = 0, insetRight = 0) {
    if (!element) {
      return;
    }

    pendingBounds = { element, insetLeft, insetRight };
    if (boundsFrame !== undefined) {
      return;
    }

    boundsFrame = requestAnimationFrame(() => {
      boundsFrame = undefined;
      const nextBounds = pendingBounds;
      pendingBounds = undefined;
      if (nextBounds) {
        void setBrowserBounds(nextBounds.element, nextBounds.insetLeft, nextBounds.insetRight);
      }
    });
  }

  function resolveBrowserBounds(element: HTMLElement, insetLeft = 0, insetRight = 0) {
    const rect = element.getBoundingClientRect();
    const viewportWidth = Math.round(rect.width);
    const minWidth = 320;
    const safeInsetLeft = Math.max(0, Math.min(Math.round(insetLeft), Math.max(0, viewportWidth - minWidth)));
    const safeInsetRight = Math.max(
      0,
      Math.min(Math.round(insetRight), Math.max(0, viewportWidth - safeInsetLeft - minWidth)),
    );
    return {
      x: Math.round(rect.left) + safeInsetLeft,
      y: Math.round(rect.top),
      width: viewportWidth - safeInsetLeft - safeInsetRight,
      height: Math.round(rect.height),
    } satisfies BrowserRect;
  }

  function closeSite() {
    void window.appApi.browser.close();
    tabs.resetTabs();
    extensions.clearSiteExtensions();
    scripts.clearSiteScripts();
    lastBrowserBounds.value = null;
    address.value = '';
    browserState.value = { ...fallbackBrowserState };
  }

  function bindEvents() {
    const removeBrowserListener = window.appApi.onBrowserStateChanged((state) => {
      tabs.setTabState(state);

      if (isActiveBrowserState(state)) {
        browserState.value = state;
        const nextAddress = state.displayUrl || state.url;
        if (nextAddress) {
          address.value = nextAddress;
        }
      }

      if (state.errorText) {
        statusMessage.value = `页面加载失败：${state.errorText}`;
      }
    });
    const removeMetadataListener = window.appApi.onSiteMetadataUpdated((nextSites) => {
      sites.value = nextSites;
    });
    const removeExtensionListener = window.appApi.onExtensionUpdated((siteId, nextExtensions) => {
      extensions.syncSiteExtensions(siteId, nextExtensions);
    });
    const removeScriptUpdateListener = window.appApi.onJarvisScriptUpdated((siteId, nextScripts) => {
      scripts.syncScripts(siteId, nextScripts);
    });
    const removeScriptMessageListener = window.appApi.onJarvisScriptMessage((message) => {
      statusMessage.value = `Jarvis 脚本消息：${message.channel}`;
    });
    const removeDownloadListener = window.appApi.onDownloadUpdated((download) => {
      const isNewDownload = !downloads.value.some((item) => item.id === download.id);
      patchDownload(download);
      lastDownloadUpdatedAt.value = Date.now();
      if (isNewDownload) {
        unacknowledgedDownloadCount.value += 1;
      }
      if (download.state === 'progressing') {
        statusMessage.value = download.paused ? `下载已暂停：${download.filename}` : `正在下载：${download.filename}`;
      } else if (download.state === 'completed') {
        statusMessage.value = `下载完成：${download.filename}`;
      } else if (download.state === 'cancelled') {
        statusMessage.value = `下载已取消：${download.filename}`;
      } else {
        statusMessage.value = `下载中断：${download.filename}`;
      }
    });
    const removeTabsListener = window.appApi.onBrowserTabsChanged((state) => {
      tabs.syncTabs(state);
      syncActiveBrowserState();
    });
    const removeSessionSyncListener = window.appApi.onOpenSessionSyncDialog((input) => {
      void openSessionSyncDialog(input);
    });
    const removeUpdateListener = window.appApi.onUpdateStatusChanged((status) => {
      appUpdateStatus.value = status;
      statusMessage.value = updateStatusMessage(status);
    });
    void syncTabs();

    return () => {
      removeBrowserListener();
      removeTabsListener();
      removeMetadataListener();
      removeExtensionListener();
      removeScriptUpdateListener();
      removeScriptMessageListener();
      removeDownloadListener();
      removeSessionSyncListener();
      removeUpdateListener();
    };
  }

  function patchSite(siteId: string, patch: Partial<Site>) {
    sites.value = sites.value.map((site) => (site.id === siteId ? { ...site, ...patch } : site));
  }

  function patchSession(siteId: string, session: SiteSession) {
    const site = sites.value.find((item) => item.id === siteId);
    if (!site) {
      return;
    }

    patchSite(siteId, {
      sessions: site.sessions.map((item) => (item.id === session.id ? session : item)),
    });
  }

  function patchDownload(download: DownloadState) {
    downloads.value = [
      download,
      ...downloads.value.filter((item) => item.id !== download.id),
    ];
  }

  function acknowledgeDownloads() {
    unacknowledgedDownloadCount.value = 0;
  }

  async function refreshBounds(element: HTMLElement | null, insetLeft = 0, insetRight = 0) {
    await nextTick();
    scheduleBrowserBounds(element, insetLeft, insetRight);
  }

  function getTabState(tabId: string) {
    return tabs.getTabState(tabId);
  }

  function tabDisplayTitle(session: SiteSession) {
    const tab = tabs.openTabs.value.find((item) => item.sessionId === session.id);
    return tab ? tabs.getTabState(tab.id)?.title || session.name : session.name;
  }

  function siteIconSrc(site?: Site | null) {
    if (!site) {
      return '';
    }

    if (site.faviconPath) {
      return toSiteFaviconSrc(site.id, site.faviconPath);
    }

    return toImageSrc(site.faviconUrl);
  }

  function siteDisplayTitle(site: Site) {
    return site.title || new URL(site.url).hostname;
  }

  function siteInitial(site: Site) {
    return siteDisplayTitle(site).trim().slice(0, 1).toUpperCase();
  }

  function sameBounds(left: BrowserRect | null, right: BrowserRect) {
    if (!left) {
      return false;
    }

    return left.x === right.x
      && left.y === right.y
      && left.width === right.width
      && left.height === right.height;
  }

  function isActiveBrowserState(state: BrowserState) {
    return state.tabId === tabs.activeTabId.value;
  }

  function syncActiveBrowserState() {
    const activeTab = tabs.selectedTab.value;
    if (!activeTab) {
      return;
    }

    const activeState = tabs.getTabState(activeTab.id);
    if (activeState) {
      browserState.value = activeState;
      address.value = activeState.displayUrl || activeState.url || activeTab.url;
      return;
    }

    browserState.value = {
      ...fallbackBrowserState,
      tabId: activeTab.id,
      kind: activeTab.kind,
      siteId: activeTab.siteId,
      sessionId: activeTab.sessionId,
      partition: activeTab.partition,
      url: activeTab.url,
      title: activeTab.title,
      favicon: activeTab.favicon,
    };
    address.value = activeTab.url;
  }

  async function syncTabs() {
    tabs.syncTabs(await window.appApi.browser.listTabs());
    syncActiveBrowserState();
  }

  return {
    sites,
    homeTabId,
    downloadsTabId,
    settingsTabId,
    activeTabId: tabs.activeTabId,
    selectedSiteId: tabs.selectedSiteId,
    selectedSessionId: tabs.selectedSessionId,
    openTabs: tabs.openTabs,
    openInternalTabs: tabs.openInternalTabs,
    activeTab: tabs.selectedTab,
    topLevelTabs: tabs.topLevelTabs,
    activeSiteSessionGroups: tabs.activeSiteSessionGroups,
    activeSessionPageTabs: tabs.activeSessionPageTabs,
    globalExtensions: extensions.globalExtensions,
    siteExtensions: extensions.siteExtensions,
    popupExtensions: extensions.popupExtensions,
    globalScripts: scripts.globalScripts,
    siteScripts: scripts.siteScripts,
    browserState,
    tabStates: tabs.statesByTabId,
    address,
    loading,
    statusMessage,
    downloads,
    downloadSettings,
    appUpdateStatus,
    lastDownloadUpdatedAt,
    unacknowledgedDownloadCount,
    sessionSyncDialog,
    activeDownloads: computed(() => downloads.value.filter((download) => download.state === 'progressing')),
    selectedSite,
    selectedSession: tabs.selectedSession,
    openSessionTabs: tabs.openSessionTabs,
    getTabState,
    tabDisplayTitle,
    siteIconSrc,
    siteDisplayTitle,
    siteInitial,
    addSite,
    updateSite,
    reorderSites,
    previewSiteOrder,
    deleteSite,
    loadSites,
    loadDownloads,
    loadSettings,
    loadUpdateStatus,
    openSite,
    addSession,
    addSessionToSite,
    openSession,
    activateHome,
    activateInternalPage,
    activateOpenTab,
    openSessionFromCurrentSite,
    openSessionFromSite,
    closeSessionTab,
    closeInternalPage,
    renameSession,
    clearSessionData,
    deleteSession,
    navigate,
    browserAction,
    hideEmbeddedView,
    showActiveView,
    setBrowserBounds,
    scheduleBrowserBounds,
    refreshBounds,
    pauseDownload,
    resumeDownload,
    cancelDownload,
    openDownload,
    showDownloadInFolder,
    removeDownload,
    clearDownloads,
    acknowledgeDownloads,
    updateDownloadSettings,
    selectDownloadPath,
    checkForUpdates,
    downloadUpdate,
    quitAndInstallUpdate,
    openSessionSyncDialog,
    closeSessionSyncDialog,
    exportSessionSync,
    previewSessionSyncImport,
    applySessionSyncImport,
    cancelSessionSyncImport,
    installGlobalExtension: extensions.installGlobalExtension,
    installSiteExtension: extensions.installSiteExtension,
    toggleGlobalExtension: extensions.toggleGlobalExtension,
    toggleSiteExtension: extensions.toggleSiteExtension,
    uninstallGlobalExtension: extensions.uninstallGlobalExtension,
    uninstallSiteExtension: extensions.uninstallSiteExtension,
    openExtensionPopup,
    closeExtensionPopup,
    installGlobalScript: scripts.installGlobalScript,
    installSiteScript: scripts.installSiteScript,
    toggleGlobalScript: scripts.toggleGlobalScript,
    toggleSiteScript: scripts.toggleSiteScript,
    uninstallGlobalScript: scripts.uninstallGlobalScript,
    uninstallSiteScript: scripts.uninstallSiteScript,
    loadScripts: scripts.loadScripts,
    closeSite,
    bindEvents,
    syncTabs,
  };
});

function normalizeUrl(value: string) {
  const trimmed = value.trim();
  if (!trimmed) {
    return trimmed;
  }

  if (needsHttpsPrefix(trimmed)) {
    return `https://${trimmed}`;
  }

  return trimmed;
}

function toImageSrc(value?: string) {
  if (!value) {
    return '';
  }

  if (/^(https?:|file:|data:|jarvis-browser:)/i.test(value)) {
    return value;
  }

  if (value.startsWith('/')) {
    return `file://${value.split('/').map(encodeURIComponent).join('/')}`;
  }

  return value;
}

function toSiteFaviconSrc(siteId: string, value: string) {
  if (/^jarvis-browser:/i.test(value)) {
    return value;
  }

  if (value.startsWith('/')) {
    return `jarvis-browser://assets/site-favicon/${encodeURIComponent(siteId)}`;
  }

  return toImageSrc(value);
}

function nextSessionName(site: Site) {
  let index = site.sessions.length + 1;
  while (site.sessions.some((session) => session.name === `会话 ${index}`)) {
    index += 1;
  }

  return `会话 ${index}`;
}

function assertUniqueSessionName(site: Site, sessionName: string) {
  if (site.sessions.some((session) => session.name === sessionName)) {
    throw new Error('同一站点下已存在同名会话');
  }
}



function internalPageStatus(pageId: BrowserInternalPageId) {
  return {
    newtab: '起始页',
    downloads: '下载记录',
    settings: '设置',
    extensions: '扩展程序管理',
    'jarvis-script': 'jarvis-script',
    history: '历史记录',
    'clear-browsing-data': '删除浏览数据',
  }[pageId];
}

function updateStatusMessage(status: AppUpdateStatus) {
  return {
    idle: '更新就绪',
    unsupported: status.errorText || '当前环境不支持自动更新',
    checking: '正在检查更新',
    available: '发现新版本，等待确认下载',
    'not-available': '当前已是最新版本',
    downloading: '正在下载更新',
    downloaded: '更新已下载，等待重启安装',
    installing: '正在重启安装更新',
    error: `更新失败：${status.errorText || '未知错误'}`,
  }[status.phase];
}
