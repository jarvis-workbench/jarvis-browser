import { defineStore } from 'pinia';
import { computed, nextTick, ref } from 'vue';
import type { BrowserState, Site, SiteSession } from '../../shared/types';
import { useBrowserExtensions } from './browser-extensions';
import { useBrowserScripts } from './browser-scripts';
import { homeTabId, useBrowserTabs } from './browser-tabs';

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
  const tabStates = ref<Record<string, BrowserState>>({});
  const address = ref('');
  const loading = ref(false);
  const statusMessage = ref('准备就绪');

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
    tabs.removeSite(site.id);
    if (tabs.selectedSiteId.value) {
      const nextSite = sites.value.find((item) => item.id === tabs.selectedSiteId.value);
      const nextSession = nextSite?.sessions.find((item) => item.id === tabs.selectedSessionId.value);
      if (nextSite && nextSession) {
        await openSession(nextSite, nextSession);
      }
    } else {
      await showHome();
    }
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

  async function openSite(siteId: string, sessionId?: string) {
    const site = sites.value.find((item) => item.id === siteId);
    if (!site) {
      statusMessage.value = '站点不存在';
      return;
    }

    await extensions.loadExtensions(site.id);

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
    tabs.activateSession(site, session);
    await extensions.loadExtensions(site.id);
    const cachedState = getTabState(session.id);
    address.value = cachedState?.displayUrl || cachedState?.url || session.lastUrl || site.url;
    await window.appApi.browser.open(site.id, session.id);
    statusMessage.value = `${session.name} 已打开`;
  }

  async function closeSessionTab(site: Site, session: SiteSession) {
    await window.appApi.browser.closeSession(site.id, session.id);
    const result = tabs.closeSession(site.id, session.id);
    delete tabStates.value[session.id];
    if (!result.closedActive) {
      return;
    }

    if (result.nextTab) {
      const nextSite = sites.value.find((item) => item.id === result.nextTab?.siteId);
      const nextSession = nextSite?.sessions.find((item) => item.id === result.nextTab?.sessionId);
      if (nextSite && nextSession) {
        await openSession(nextSite, nextSession);
        return;
      }
    }

    await showHome();
  }

  async function activateHome() {
    await showHome();
  }

  async function showHome() {
    tabs.activateHome();
    await window.appApi.browser.showHome();
    extensions.clearSiteExtensions();
    scripts.clearSiteScripts();
    address.value = '';
    browserState.value = { ...fallbackBrowserState, title: '起始页' };
    statusMessage.value = '起始页';
  }

  async function activateOpenTab(tab: { site: Site; session: SiteSession }) {
    await openSession(tab.site, tab.session);
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
    delete tabStates.value[session.id];
    const remaining = site.sessions.filter((item) => item.id !== session.id);
    patchSite(site.id, { sessions: remaining });

    if (tabs.selectedSessionId.value === session.id) {
      tabs.removeSession(site.id, session.id);
      const nextSession = remaining[0] ?? null;
      address.value = nextSession?.lastUrl ?? site.url;
      if (nextSession) {
        await openSession({ ...site, sessions: remaining }, nextSession);
      } else {
        await showHome();
      }
    } else {
      tabs.removeSession(site.id, session.id);
    }
    statusMessage.value = '会话已移除';
  }

  async function navigate() {
    if (!tabs.selectedSession.value || !address.value.trim()) {
      return;
    }

    const nextUrl = normalizeUrl(address.value);
    address.value = nextUrl;
    browserState.value = { ...browserState.value, url: nextUrl, isLoading: true };
    await window.appApi.browser.navigate(nextUrl);
    statusMessage.value = `正在访问 ${nextUrl}`;
  }

  async function browserAction(action: 'back' | 'forward' | 'reload' | 'stop') {
    await window.appApi.browser[action]();
  }

  async function setBrowserBounds(element: HTMLElement | null, insetLeft = 0, insetRight = 0) {
    if (!element || !tabs.selectedSession.value) {
      return;
    }

    const rect = element.getBoundingClientRect();
    const viewportWidth = Math.round(rect.width);
    const minWidth = 320;
    const safeInsetLeft = Math.max(0, Math.min(Math.round(insetLeft), Math.max(0, viewportWidth - minWidth)));
    const safeInsetRight = Math.max(
      0,
      Math.min(Math.round(insetRight), Math.max(0, viewportWidth - safeInsetLeft - minWidth)),
    );
    await window.appApi.browser.setBounds({
      x: Math.round(rect.left) + safeInsetLeft,
      y: Math.round(rect.top),
      width: viewportWidth - safeInsetLeft - safeInsetRight,
      height: Math.round(rect.height),
    });
  }

  function closeSite() {
    void window.appApi.browser.close();
    tabs.resetTabs();
    extensions.clearSiteExtensions();
    scripts.clearSiteScripts();
    tabStates.value = {};
    address.value = '';
    browserState.value = { ...fallbackBrowserState };
  }

  function bindEvents() {
    const removeBrowserListener = window.appApi.onBrowserStateChanged((state) => {
      if (state.sessionId) {
        tabStates.value = {
          ...tabStates.value,
          [state.sessionId]: state,
        };
      }

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

    return () => {
      removeBrowserListener();
      removeMetadataListener();
      removeExtensionListener();
      removeScriptUpdateListener();
      removeScriptMessageListener();
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

  async function refreshBounds(element: HTMLElement | null, insetLeft = 0, insetRight = 0) {
    await nextTick();
    await setBrowserBounds(element, insetLeft, insetRight);
  }

  function getTabState(sessionId: string) {
    return tabStates.value[sessionId];
  }

  function tabDisplayTitle(session: SiteSession) {
    return tabStates.value[session.id]?.title || session.name;
  }

  function siteIconSrc(site?: Site | null) {
    return toImageSrc(site?.faviconPath || site?.faviconUrl);
  }

  function siteDisplayTitle(site: Site) {
    return site.title || new URL(site.url).hostname;
  }

  function siteInitial(site: Site) {
    return siteDisplayTitle(site).trim().slice(0, 1).toUpperCase();
  }

  function isActiveBrowserState(state: BrowserState) {
    return state.siteId === tabs.selectedSiteId.value && state.sessionId === tabs.selectedSessionId.value;
  }

  return {
    sites,
    homeTabId,
    activeTabId: tabs.activeTabId,
    selectedSiteId: tabs.selectedSiteId,
    selectedSessionId: tabs.selectedSessionId,
    openTabs: tabs.openTabs,
    globalExtensions: extensions.globalExtensions,
    siteExtensions: extensions.siteExtensions,
    globalScripts: scripts.globalScripts,
    siteScripts: scripts.siteScripts,
    browserState,
    tabStates,
    address,
    loading,
    statusMessage,
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
    deleteSite,
    loadSites,
    openSite,
    addSession,
    addSessionToSite,
    openSession,
    activateHome,
    activateOpenTab,
    openSessionFromCurrentSite,
    openSessionFromSite,
    closeSessionTab,
    renameSession,
    clearSessionData,
    deleteSession,
    navigate,
    browserAction,
    setBrowserBounds,
    refreshBounds,
    installGlobalExtension: extensions.installGlobalExtension,
    installSiteExtension: extensions.installSiteExtension,
    toggleGlobalExtension: extensions.toggleGlobalExtension,
    toggleSiteExtension: extensions.toggleSiteExtension,
    uninstallGlobalExtension: extensions.uninstallGlobalExtension,
    uninstallSiteExtension: extensions.uninstallSiteExtension,
    installGlobalScript: scripts.installGlobalScript,
    installSiteScript: scripts.installSiteScript,
    toggleGlobalScript: scripts.toggleGlobalScript,
    toggleSiteScript: scripts.toggleSiteScript,
    uninstallGlobalScript: scripts.uninstallGlobalScript,
    uninstallSiteScript: scripts.uninstallSiteScript,
    loadScripts: scripts.loadScripts,
    closeSite,
    bindEvents,
  };
});

function normalizeUrl(value: string) {
  const trimmed = value.trim();
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

function toImageSrc(value?: string) {
  if (!value) {
    return '';
  }

  if (/^(https?:|file:|data:|jarvis-asset:)/i.test(value)) {
    return value;
  }

  if (value.startsWith('/')) {
    return `file://${value.split('/').map(encodeURIComponent).join('/')}`;
  }

  return value;
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

function formatError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
