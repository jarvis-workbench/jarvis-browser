import { computed, ref, type Ref } from 'vue';
import type { Site, SiteSession } from '../../shared/types';

export const homeTabId = 'home';

export interface OpenBrowserTab {
  id: string;
  siteId: string;
  sessionId: string;
}

export function useBrowserTabs(sites: Ref<Site[]>) {
  const activeTabId = ref(homeTabId);
  const openTabs = ref<OpenBrowserTab[]>([]);

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
  }

  return {
    activeTabId,
    openTabs,
    selectedTab,
    selectedSite,
    selectedSiteId,
    selectedSession,
    selectedSessionId,
    openSessionTabs,
    activateHome,
    activateSession,
    closeSession,
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
