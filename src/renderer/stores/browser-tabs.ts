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

export type SiteSessionGroup = {
  key: string;
  site: Site;
  session: SiteSession;
  tabs: SiteSessionTab[];
  activeTab: SiteSessionTab;
};

export type SiteTopLevelTab = {
  type: 'site';
  key: string;
  site: Site;
  sessionGroups: SiteSessionGroup[];
  activeSessionGroup: SiteSessionGroup;
  activeSessionTab: SiteSessionTab;
};

export type TopLevelTab = DirectTopLevelTab | SiteTopLevelTab;

export function useBrowserTabs(sites: Ref<Site[]>) {
  const activeTabId = ref<string | undefined>();
  const tabOrder = ref<string[]>([]);
  const tabsById = ref<Record<string, BrowserTab>>({});
  const statesByTabId = ref<Record<string, BrowserState>>({});
  const lastActiveTabIdBySiteId = ref<Record<string, string>>({});
  const lastActiveTabIdBySessionKey = ref<Record<string, string>>({});

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
  const selectedSessionKey = computed(() => (
    selectedTab.value?.siteId && selectedTab.value.sessionId
      ? toSessionKey(selectedTab.value.siteId, selectedTab.value.sessionId)
      : null
  ));
  const openInternalTabs = computed(() => openTabs.value.filter((tab) => tab.kind === 'internal'));
  const openSessionTabs = computed(() =>
    openTabs.value
      .filter((tab) => tab.kind !== 'internal' && tab.siteId && tab.sessionId)
      .map((tab) => {
        const site = tab.siteId ? sitesById.value.get(tab.siteId) : undefined;
        const session = site?.sessions.find((item) => item.id === tab.sessionId);
        return site && session ? { ...tab, site, session } : undefined;
      })
      .filter((tab): tab is SiteSessionTab => Boolean(tab)),
  );
  const topLevelTabs = computed<TopLevelTab[]>(() => {
    const topTabs: TopLevelTab[] = [];
    const siteGroups = new Map<string, SiteTopLevelTab>();
    const sessionTabsById = new Map(openSessionTabs.value.map((tab) => [tab.id, tab]));

    for (const tab of openTabs.value) {
      if (tab.kind === 'internal' || !tab.siteId || !tab.sessionId) {
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

      let siteGroup = siteGroups.get(siteTab.site.id);
      if (!siteGroup) {
        const sessionGroup = createSessionGroup(siteTab);
        siteGroup = {
          type: 'site',
          key: `site:${siteTab.site.id}`,
          site: siteTab.site,
          sessionGroups: [sessionGroup],
          activeSessionGroup: sessionGroup,
          activeSessionTab: sessionGroup.activeTab,
        };
        siteGroups.set(siteTab.site.id, siteGroup);
        topTabs.push(siteGroup);
        continue;
      }

      let sessionGroup = siteGroup.sessionGroups.find((group) => group.session.id === siteTab.session.id);
      if (!sessionGroup) {
        sessionGroup = createSessionGroup(siteTab);
        siteGroup.sessionGroups.push(sessionGroup);
      } else {
        sessionGroup.tabs.push(siteTab);
      }
      syncSiteGroupActiveTab(siteGroup);
    }

    return topTabs;
  });
  const activeSiteSessionGroups = computed(() => {
    const siteId = selectedTab.value?.siteId;
    return siteId ? topLevelTabs.value.find((tab): tab is SiteTopLevelTab =>
      tab.type === 'site' && tab.site.id === siteId,
    )?.sessionGroups ?? [] : [];
  });
  const activeSessionPageTabs = computed(() => {
    const sessionKey = selectedSessionKey.value;
    if (!sessionKey) {
      return [];
    }

    return activeSiteSessionGroups.value.find((group) => group.key === sessionKey)?.tabs ?? [];
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
    if (activeTab?.siteId && activeTab.sessionId) {
      lastActiveTabIdBySessionKey.value = {
        ...lastActiveTabIdBySessionKey.value,
        [toSessionKey(activeTab.siteId, activeTab.sessionId)]: activeTab.id,
      };
    }
  }

  function resetTabs() {
    activeTabId.value = undefined;
    tabOrder.value = [];
    tabsById.value = {};
    statesByTabId.value = {};
    lastActiveTabIdBySiteId.value = {};
    lastActiveTabIdBySessionKey.value = {};
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

    const nextLastActiveBySite = { ...lastActiveTabIdBySiteId.value };
    let lastActiveBySiteChanged = false;
    for (const [siteId, tabId] of Object.entries(nextLastActiveBySite)) {
      if (!openTabIds.has(tabId)) {
        delete nextLastActiveBySite[siteId];
        lastActiveBySiteChanged = true;
      }
    }
    if (lastActiveBySiteChanged) {
      lastActiveTabIdBySiteId.value = nextLastActiveBySite;
    }

    const nextLastActiveBySession = { ...lastActiveTabIdBySessionKey.value };
    let lastActiveBySessionChanged = false;
    for (const [sessionKey, tabId] of Object.entries(nextLastActiveBySession)) {
      if (!openTabIds.has(tabId)) {
        delete nextLastActiveBySession[sessionKey];
        lastActiveBySessionChanged = true;
      }
    }
    if (lastActiveBySessionChanged) {
      lastActiveTabIdBySessionKey.value = nextLastActiveBySession;
    }
  }

  function createSessionGroup(tab: SiteSessionTab): SiteSessionGroup {
    return {
      key: toSessionKey(tab.site.id, tab.session.id),
      site: tab.site,
      session: tab.session,
      tabs: [tab],
      activeTab: tab,
    };
  }

  function syncSiteGroupActiveTab(siteGroup: SiteTopLevelTab) {
    for (const sessionGroup of siteGroup.sessionGroups) {
      sessionGroup.activeTab = resolveActiveSessionPageTab(sessionGroup);
    }
    siteGroup.activeSessionGroup = resolveActiveSessionGroup(siteGroup);
    siteGroup.activeSessionTab = siteGroup.activeSessionGroup.activeTab;
  }

  function resolveActiveSessionGroup(siteGroup: SiteTopLevelTab) {
    const currentActive = selectedTab.value?.siteId === siteGroup.site.id
      ? siteGroup.sessionGroups.find((group) => group.session.id === selectedTab.value?.sessionId)
      : undefined;
    const lastActive = lastActiveTabIdBySiteId.value[siteGroup.site.id];
    return currentActive
      || siteGroup.sessionGroups.find((group) => group.tabs.some((tab) => tab.id === lastActive))
      || siteGroup.sessionGroups.at(-1)
      || siteGroup.sessionGroups[0];
  }

  function resolveActiveSessionPageTab(group: SiteSessionGroup) {
    const currentActive = selectedTab.value?.siteId === group.site.id && selectedTab.value.sessionId === group.session.id
      ? group.tabs.find((tab) => tab.id === selectedTab.value?.id)
      : undefined;
    return currentActive
      || group.tabs.find((tab) => tab.id === lastActiveTabIdBySessionKey.value[group.key])
      || group.tabs.find((tab) => !tab.parentTabId)
      || group.tabs.at(-1)
      || group.tabs[0];
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
    activeSiteSessionGroups,
    activeSessionPageTabs,
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

function toSessionKey(siteId: string, sessionId: string) {
  return `${siteId}:${sessionId}`;
}
