import { computed, ref, type Ref } from 'vue';
import type { Site, SiteSession } from '../../shared/types';

export const homeTabId = 'home';
export const downloadsTabId = 'downloads';
export const settingsTabId = 'settings';

export type InternalPageTabId = typeof downloadsTabId | typeof settingsTabId;

export interface OpenBrowserTab {
  id: string;
  siteId: string;
  sessionId: string;
}

export interface OpenInternalTab {
  id: InternalPageTabId;
  title: string;
  url: string;
}

const internalPageTitles: Record<InternalPageTabId, string> = {
  [downloadsTabId]: '下载内容',
  [settingsTabId]: '设置',
};

export const internalPageUrls: Record<InternalPageTabId, string> = {
  [downloadsTabId]: 'jarvis://downloads',
  [settingsTabId]: 'jarvis://settings',
};

export function useBrowserTabs(sites: Ref<Site[]>) {
  const activeTabId = ref(homeTabId);
  const openTabs = ref<OpenBrowserTab[]>([]);
  const openInternalTabs = ref<OpenInternalTab[]>([]);

  const selectedTab = computed(() => openTabs.value.find((tab) => tab.id === activeTabId.value) ?? null);
  const selectedSite = computed(() =>
    selectedTab.value ? sites.value.find((site) => site.id === selectedTab.value?.siteId) ?? null : null,
  );
  const selectedSession = computed(() =>
    selectedSite.value?.sessions.find((session) => session.id === selectedTab.value?.sessionId) ?? null,
  );
  const selectedSiteId = computed(() => selectedTab.value?.siteId ?? null);
  const selectedSessionId = computed(() => selectedTab.value?.sessionId ?? null);

  const openSessionTabs = computed(() =>
    openTabs.value
      .map((tab) => {
        const site = sites.value.find((item) => item.id === tab.siteId);
        const session = site?.sessions.find((item) => item.id === tab.sessionId);
        return site && session ? { ...tab, site, session } : undefined;
      })
      .filter((tab): tab is OpenBrowserTab & { site: Site; session: SiteSession } => Boolean(tab)),
  );

  function activateHome() {
    activeTabId.value = homeTabId;
  }

  function activateInternalPage(pageId: InternalPageTabId) {
    if (!openInternalTabs.value.some((tab) => tab.id === pageId)) {
      openInternalTabs.value = [
        ...openInternalTabs.value,
        { id: pageId, title: internalPageTitles[pageId], url: internalPageUrls[pageId] },
      ];
    }
    activeTabId.value = pageId;
  }

  function activateSession(site: Site, session: SiteSession) {
    const tab = toOpenTab(site.id, session.id);
    if (!openTabs.value.some((item) => item.id === tab.id)) {
      openTabs.value = [...openTabs.value, tab];
    }
    activeTabId.value = tab.id;
  }

  function closeSession(siteId: string, sessionId: string) {
    const tabId = createTabId(siteId, sessionId);
    const index = openTabs.value.findIndex((tab) => tab.id === tabId);
    openTabs.value = openTabs.value.filter((tab) => tab.id !== tabId);
    if (activeTabId.value !== tabId) {
      return { closedActive: false, nextTab: undefined };
    }

    const nextTab = openTabs.value[index] ?? openTabs.value[index - 1];
    activeTabId.value = nextTab?.id ?? homeTabId;
    return { closedActive: true, nextTab };
  }

  function closeInternalPage(pageId: InternalPageTabId) {
    openInternalTabs.value = openInternalTabs.value.filter((tab) => tab.id !== pageId);
    if (activeTabId.value !== pageId) {
      return;
    }

    activeTabId.value = openTabs.value[openTabs.value.length - 1]?.id ?? homeTabId;
  }

  function removeSite(siteId: string) {
    const removedActive = selectedTab.value?.siteId === siteId;
    openTabs.value = openTabs.value.filter((tab) => tab.siteId !== siteId);
    if (removedActive) {
      activeTabId.value = openTabs.value[0]?.id ?? homeTabId;
    }
  }

  function removeSession(siteId: string, sessionId: string) {
    return closeSession(siteId, sessionId);
  }

  function resetTabs() {
    activeTabId.value = homeTabId;
    openTabs.value = [];
    openInternalTabs.value = [];
  }

  return {
    activeTabId,
    openTabs,
    openInternalTabs,
    selectedTab,
    selectedSite,
    selectedSiteId,
    selectedSession,
    selectedSessionId,
    openSessionTabs,
    activateHome,
    activateInternalPage,
    activateSession,
    closeSession,
    closeInternalPage,
    removeSite,
    removeSession,
    resetTabs,
  };
}

function toOpenTab(siteId: string, sessionId: string): OpenBrowserTab {
  return {
    id: createTabId(siteId, sessionId),
    siteId,
    sessionId,
  };
}

function createTabId(siteId: string, sessionId: string) {
  return `${siteId}:${sessionId}`;
}
