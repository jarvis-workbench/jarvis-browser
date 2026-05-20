import { computed, ref, type Ref } from 'vue';
import type { BrowserInternalPageId, BrowserState, BrowserTab, Site, SiteSession } from '../../shared/types';

export const newTabPageId = 'newtab';
export const downloadsTabId = 'downloads';
export const settingsTabId = 'settings';
export const extensionsTabId = 'extensions';
export const jarvisScriptTabId = 'jarvis-script';
export const historyTabId = 'history';
export const clearBrowsingDataTabId = 'clear-browsing-data';
export const homeTabId = newTabPageId;

export type InternalPageTabId = BrowserInternalPageId;

export const internalPageUrls: Record<InternalPageTabId, string> = {
  [newTabPageId]: 'jarvis-browser://newtab',
  [downloadsTabId]: 'jarvis-browser://downloads',
  [settingsTabId]: 'jarvis-browser://settings',
  [extensionsTabId]: 'jarvis-browser://extensions',
  [jarvisScriptTabId]: 'jarvis-browser://jarvis-script',
  [historyTabId]: 'jarvis-browser://history',
  [clearBrowsingDataTabId]: 'jarvis-browser://clear-browsing-data',
};

export type DirectTopLevelTab = {
  type: 'direct';
  key: string;
  tab: BrowserTab;
};

export type SiteSessionTab = BrowserTab & {
  site: Site;
  session: SiteSession;
};

export type SiteTopLevelTab = {
  type: 'site';
  key: string;
  site: Site;
  tabs: SiteSessionTab[];
  activeSessionTab: SiteSessionTab;
};

export type TopLevelTab = DirectTopLevelTab | SiteTopLevelTab;

export function useBrowserTabs(sites: Ref<Site[]>) {
  const activeTabId = ref<string | undefined>();
  const tabOrder = ref<string[]>([]);
  const tabsById = ref<Record<string, BrowserTab>>({});
  const statesByTabId = ref<Record<string, BrowserState>>({});
  const lastActiveTabIdBySiteId = ref<Record<string, string>>({});

  const sitesById = computed(() => new Map(sites.value.map((site) => [site.id, site])));
  const openTabs = computed(() => tabOrder.value.map((tabId) => tabsById.value[tabId]).filter(Boolean));
  const selectedTab = computed(() => activeTabId.value ? tabsById.value[activeTabId.value] ?? null : null);
  const selectedSite = computed(() =>
    selectedTab.value?.siteId ? sitesById.value.get(selectedTab.value.siteId) ?? null : null,
  );
  const selectedSession = computed(() =>
    selectedSite.value?.sessions.find((session) => session.id === selectedTab.value?.sessionId) ?? null,
  );
  const selectedSiteId = computed(() => selectedTab.value?.siteId ?? null);
  const selectedSessionId = computed(() => selectedTab.value?.sessionId ?? null);
  const openInternalTabs = computed(() => openTabs.value.filter((tab) => tab.kind === 'internal'));
  const openSessionTabs = computed(() =>
    openTabs.value
      .filter((tab) => tab.kind === 'site')
      .map((tab) => {
        const site = tab.siteId ? sitesById.value.get(tab.siteId) : undefined;
        const session = site?.sessions.find((item) => item.id === tab.sessionId);
        return site && session ? { ...tab, site, session } : undefined;
      })
      .filter((tab): tab is SiteSessionTab => Boolean(tab)),
  );
  const activeSiteSessionTabs = computed(() => {
    const siteId = selectedTab.value?.siteId;
    return siteId ? openSessionTabs.value.filter((tab) => tab.siteId === siteId) : [];
  });
  const topLevelTabs = computed<TopLevelTab[]>(() => {
    const topTabs: TopLevelTab[] = [];
    const siteGroups = new Map<string, SiteTopLevelTab>();
    const sessionTabsById = new Map(openSessionTabs.value.map((tab) => [tab.id, tab]));

    for (const tab of openTabs.value) {
      if (tab.kind !== 'site' || !tab.siteId) {
        topTabs.push({
          type: 'direct',
          key: tab.id,
          tab,
        });
        continue;
      }

      const siteTab = sessionTabsById.get(tab.id);
      if (!siteTab) {
        continue;
      }

      let group = siteGroups.get(siteTab.site.id);
      if (!group) {
        group = {
          type: 'site',
          key: `site:${siteTab.site.id}`,
          site: siteTab.site,
          tabs: [],
          activeSessionTab: siteTab,
        };
        siteGroups.set(siteTab.site.id, group);
        topTabs.push(group);
      }
      group.tabs.push(siteTab);
      group.activeSessionTab = resolveActiveSessionTab(siteTab.site.id, group.tabs);
    }

    return topTabs;
  });

  function syncTabs(state: { activeTabId?: string; tabs: BrowserTab[] }) {
    const nextIds = new Set(state.tabs.map((tab) => tab.id));
    const nextTabsById: Record<string, BrowserTab> = {};
    for (const tab of state.tabs) {
      nextTabsById[tab.id] = tab;
    }

    activeTabId.value = state.activeTabId;
    tabOrder.value = state.tabs.map((tab) => tab.id);
    tabsById.value = nextTabsById;
    pruneClosedTabs(nextIds);

    const activeTab = state.activeTabId ? nextTabsById[state.activeTabId] : undefined;
    if (activeTab?.siteId) {
      lastActiveTabIdBySiteId.value = {
        ...lastActiveTabIdBySiteId.value,
        [activeTab.siteId]: activeTab.id,
      };
    }
  }

  function resetTabs() {
    activeTabId.value = undefined;
    tabOrder.value = [];
    tabsById.value = {};
    statesByTabId.value = {};
    lastActiveTabIdBySiteId.value = {};
  }

  function setTabState(state: BrowserState) {
    if (!state.tabId) {
      return;
    }

    statesByTabId.value = {
      ...statesByTabId.value,
      [state.tabId]: state,
    };
  }

  function removeTabState(tabId: string) {
    if (!statesByTabId.value[tabId]) {
      return;
    }

    const nextStates = { ...statesByTabId.value };
    delete nextStates[tabId];
    statesByTabId.value = nextStates;
  }

  function removeSessionTabStates(siteId: string, sessionId: string) {
    const matchingTabIds = openTabs.value
      .filter((tab) => tab.siteId === siteId && tab.sessionId === sessionId)
      .map((tab) => tab.id);
    for (const tabId of matchingTabIds) {
      removeTabState(tabId);
    }
  }

  function getTabState(tabId: string) {
    return statesByTabId.value[tabId];
  }

  function findSessionTab(siteId: string, sessionId: string) {
    return openTabs.value.find((tab) => tab.siteId === siteId && tab.sessionId === sessionId);
  }

  function pruneClosedTabs(openTabIds: Set<string>) {
    const nextStates = { ...statesByTabId.value };
    let statesChanged = false;
    for (const tabId of Object.keys(nextStates)) {
      if (!openTabIds.has(tabId)) {
        delete nextStates[tabId];
        statesChanged = true;
      }
    }
    if (statesChanged) {
      statesByTabId.value = nextStates;
    }

    const nextLastActive = { ...lastActiveTabIdBySiteId.value };
    let lastActiveChanged = false;
    for (const [siteId, tabId] of Object.entries(nextLastActive)) {
      if (!openTabIds.has(tabId)) {
        delete nextLastActive[siteId];
        lastActiveChanged = true;
      }
    }
    if (lastActiveChanged) {
      lastActiveTabIdBySiteId.value = nextLastActive;
    }
  }

  function resolveActiveSessionTab(siteId: string, tabs: SiteSessionTab[]) {
    const currentActive = selectedTab.value?.siteId === siteId
      ? tabs.find((tab) => tab.id === selectedTab.value?.id)
      : undefined;
    return currentActive
      || tabs.find((tab) => tab.id === lastActiveTabIdBySiteId.value[siteId])
      || tabs.at(-1)
      || tabs[0];
  }

  return {
    activeTabId,
    tabsById,
    tabOrder,
    statesByTabId,
    openTabs,
    openInternalTabs,
    selectedTab,
    selectedSite,
    selectedSiteId,
    selectedSession,
    selectedSessionId,
    openSessionTabs,
    activeSiteSessionTabs,
    topLevelTabs,
    syncTabs,
    resetTabs,
    setTabState,
    removeTabState,
    removeSessionTabStates,
    getTabState,
    findSessionTab,
  };
}
