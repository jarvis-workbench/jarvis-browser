import { computed, ref, type Ref } from 'vue';
import type { BrowserInternalPageId, BrowserTab, Site, SiteSession } from '../../shared/types';

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

export function useBrowserTabs(sites: Ref<Site[]>) {
  const activeTabId = ref<string | undefined>();
  const openTabs = ref<BrowserTab[]>([]);

  const selectedTab = computed(() => openTabs.value.find((tab) => tab.id === activeTabId.value) ?? null);
  const selectedSite = computed(() =>
    selectedTab.value?.siteId ? sites.value.find((site) => site.id === selectedTab.value?.siteId) ?? null : null,
  );
  const selectedSession = computed(() =>
    selectedSite.value?.sessions.find((session) => session.id === selectedTab.value?.sessionId) ?? null,
  );
  const selectedSiteId = computed(() => selectedTab.value?.siteId ?? null);
  const selectedSessionId = computed(() => selectedTab.value?.sessionId ?? null);
  const openSessionTabs = computed(() =>
    openTabs.value
      .filter((tab) => tab.kind === 'site')
      .map((tab) => {
        const site = sites.value.find((item) => item.id === tab.siteId);
        const session = site?.sessions.find((item) => item.id === tab.sessionId);
        return site && session ? { ...tab, site, session } : undefined;
      })
      .filter((tab): tab is BrowserTab & { site: Site; session: SiteSession } => Boolean(tab)),
  );

  function syncTabs(state: { activeTabId?: string; tabs: BrowserTab[] }) {
    activeTabId.value = state.activeTabId;
    openTabs.value = state.tabs;
  }

  function resetTabs() {
    activeTabId.value = undefined;
    openTabs.value = [];
  }

  return {
    activeTabId,
    openTabs,
    openInternalTabs: computed(() => openTabs.value.filter((tab) => tab.kind === 'internal')),
    selectedTab,
    selectedSite,
    selectedSiteId,
    selectedSession,
    selectedSessionId,
    openSessionTabs,
    syncTabs,
    resetTabs,
  };
}
