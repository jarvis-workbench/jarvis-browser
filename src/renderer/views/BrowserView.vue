<script setup lang="ts">
import {
  AddOne,
  Close,
  Code,
  Delete,
  Download,
  Home,
  Left,
  Loading,
  More,
  Puzzle,
  Refresh,
  Right,
  Setting,
  Time,
} from '@icon-park/vue-next';
import {
  ElButton,
  ElInput,
  ElMessage,
} from 'element-plus';
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { BrowserRect, Site, SiteSession } from '../../shared/types';
import BrowserDrawer from '../components/BrowserDrawer.vue';
import SessionDrawer from '../components/SessionDrawer.vue';
import {
  clearBrowsingDataTabId,
  downloadsTabId,
  extensionsTabId,
  historyTabId,
  jarvisScriptTabId,
  settingsTabId,
  type TopLevelTab,
  type InternalPageTabId,
  type SiteSessionGroup,
  type SiteSessionTab,
} from '../stores/browser-tabs';
import { useBrowserStore } from '../stores/browser';

const browser = useBrowserStore();
const browserHost = ref<HTMLElement | null>(null);
type ActivePanel = 'tabPicker' | 'sessionDrawer' | 'sessionCreator' | null;
const activePanel = ref<ActivePanel>(null);
const sessionDrawerVisible = ref(false);
const tabPickerVisible = ref(false);
const creatingSession = ref(false);
const creatingSessionSubmitting = ref(false);
const newSessionName = ref('');
const creatingSessionSite = ref<Site | null>(null);
const nowTick = ref(Date.now());

let resizeObserver: ResizeObserver | undefined;
let downloadActivityTimer: number | undefined;
let pendingDragOrderKey = '';
let activeDragPayload: TabDragPayload | null = null;

const selectedUrl = computed(() => browser.browserState.displayUrl || browser.browserState.url || browser.selectedSite?.url || '');
const displayedAddress = computed(() => {
  if (activeTab.value?.kind === 'internal') {
    return activeTab.value.url;
  }

  return browser.address;
});
const activeTab = computed(() => browser.activeTab);
const isHomeActive = computed(() => activeTab.value?.internalPageId === browser.homeTabId);
const isDownloadsActive = computed(() => activeTab.value?.internalPageId === browser.downloadsTabId);
const isSettingsActive = computed(() => activeTab.value?.internalPageId === browser.settingsTabId);
const isInternalPageActive = computed(() => activeTab.value?.kind === 'internal');
const currentSessionName = computed(() => (
  activeTab.value?.siteId && activeTab.value.sessionId ? browser.selectedSession?.name ?? '' : ''
));
const activeSiteSessionGroups = computed(() => browser.activeSiteSessionGroups);
const activeSessionPageTabs = computed(() => browser.activeSessionPageTabs);
const topLevelTabs = computed(() => browser.topLevelTabs);
const hasSessionTabs = computed(() => activeSiteSessionGroups.value.length > 0);
const hasPageTabs = computed(() => activeSessionPageTabs.value.length > 1);
const browserInsetLeft = computed(() => 0);
const browserInsetRight = computed(() => {
  if (isInternalPageActive.value) {
    return 0;
  }

  return Math.max(
    sessionDrawerVisible.value || tabPickerVisible.value ? 360 : 0,
    creatingSession.value ? 320 : 0,
  );
});
const creatingSessionTitle = computed(() => (
  creatingSessionSite.value ? `新建会话 - ${creatingSessionSite.value.title}` : '新建会话'
));
const activeDownloadCount = computed(() => browser.activeDownloads.length);
const downloadIndicatorCount = computed(() => browser.unacknowledgedDownloadCount || activeDownloadCount.value);
const hasRecentDownloadActivity = computed(() => nowTick.value - browser.lastDownloadUpdatedAt < 1800);
const downloadProgress = computed(() => {
  const activeDownloads = browser.activeDownloads.filter((download) => download.totalBytes > 0);
  if (!activeDownloads.length) {
    return 0;
  }

  const receivedBytes = activeDownloads.reduce((total, download) => total + download.receivedBytes, 0);
  const totalBytes = activeDownloads.reduce((total, download) => total + download.totalBytes, 0);
  return totalBytes ? Math.max(0, Math.min(100, Math.round((receivedBytes / totalBytes) * 100))) : 0;
});

async function setActivePanel(panel: ActivePanel) {
  if (panel) {
    await browser.closeExtensionPopup();
    await window.appApi.overlays.close();
  }
  activePanel.value = panel;
  tabPickerVisible.value = panel === 'tabPicker';
  sessionDrawerVisible.value = panel === 'sessionDrawer';
  creatingSession.value = panel === 'sessionCreator';
  browser.scheduleBrowserBounds(browserHost.value, browserInsetLeft.value, browserInsetRight.value);
}

async function togglePanel(panel: Exclude<ActivePanel, null>) {
  await setActivePanel(activePanel.value === panel ? null : panel);
}

async function syncPanelVisibility(panel: Exclude<ActivePanel, null>, visible: boolean) {
  if (!visible && activePanel.value === panel) {
    await setActivePanel(null);
  }
}

async function ensureSiteOpen() {
  if (!browser.sites.length) {
    await browser.loadSites();
  }

  await browser.syncTabs();
  if (!browser.activeTabId) {
    await browser.activateHome();
  }

  await nextTick();
  browser.scheduleBrowserBounds(browserHost.value, browserInsetLeft.value, browserInsetRight.value);
}

async function addSession() {
  if (creatingSessionSubmitting.value) {
    return;
  }

  try {
    creatingSessionSubmitting.value = true;
    const site = creatingSessionSite.value || browser.selectedSite;
    if (!site) {
      throw new Error('请选择站点');
    }
    const session = await browser.addSessionToSite(site, newSessionName.value);
    await browser.openSessionFromSite(site, session);
    newSessionName.value = '';
    await setActivePanel(null);
    ElMessage.success('会话已创建');
    browser.scheduleBrowserBounds(browserHost.value, browserInsetLeft.value, browserInsetRight.value);
  } catch (error) {
    ElMessage.error(formatError(error));
  } finally {
    creatingSessionSubmitting.value = false;
  }
}

function isTabLoading(tabId: string) {
  return Boolean(browser.getTabState(tabId)?.isLoading);
}

function isTopLevelTabLoading(tab: TopLevelTab) {
  return tab.type === 'site' ? isTabLoading(tab.activeSessionTab.id) : isTabLoading(tab.tab.id);
}

function tabTitle(tab: { id: string; title: string; url: string }) {
  return browser.getTabState(tab.id)?.title || tab.title || tab.url;
}

function sessionGroupTitle(group: SiteSessionGroup) {
  return group.session.name;
}

function pageTabTitle(tab: SiteSessionTab) {
  const stateTitle = browser.getTabState(tab.id)?.title?.trim();
  if (stateTitle) {
    return stateTitle;
  }

  return tab.title || tab.url;
}

function topLevelTabTitle(tab: TopLevelTab) {
  return tab.type === 'site' ? browser.siteDisplayTitle(tab.site) : tabTitle(tab.tab);
}

function topLevelTabInitial(tab: TopLevelTab) {
  return topLevelTabTitle(tab).trim().slice(0, 1).toUpperCase();
}

function topLevelTabFavicon(tab: TopLevelTab) {
  if (tab.type === 'site') {
    return browser.siteIconSrc(tab.site) || tabFaviconSrc(tab.activeSessionTab);
  }

  return tabFaviconSrc(tab.tab);
}

function tabFaviconSrc(tab: { favicon?: string }) {
  return toImageSrc(tab.favicon);
}

function isTopLevelTabActive(tab: TopLevelTab) {
  return tab.type === 'site'
    ? activeTab.value?.siteId === tab.site.id
    : browser.activeTabId === tab.tab.id;
}

async function openSessionFromDrawer(session: SiteSession) {
  try {
    await browser.openSessionFromCurrentSite(session);
    await setActivePanel(null);
    browser.scheduleBrowserBounds(browserHost.value, browserInsetLeft.value, browserInsetRight.value);
  } catch (error) {
    ElMessage.error(formatError(error));
  }
}

async function openSessionFromPicker(site: Site, session: SiteSession) {
  try {
    await browser.openSessionFromSite(site, session);
    await setActivePanel(null);
    browser.scheduleBrowserBounds(browserHost.value, browserInsetLeft.value, browserInsetRight.value);
  } catch (error) {
    ElMessage.error(formatError(error));
  }
}

async function openSessionsFromPicker(site: Site, sessions: SiteSession[]) {
  try {
    for (const session of sessions) {
      await browser.openSessionFromSite(site, session);
    }
    await setActivePanel(null);
    browser.scheduleBrowserBounds(browserHost.value, browserInsetLeft.value, browserInsetRight.value);
  } catch (error) {
    ElMessage.error(formatError(error));
  }
}

async function navigate() {
  try {
    await browser.navigate();
  } catch (error) {
    ElMessage.error(formatError(error));
  }
}

async function browserAction(action: 'back' | 'forward' | 'reload' | 'stop') {
  try {
    await browser.browserAction(action);
  } catch (error) {
    ElMessage.error(formatError(error));
  }
}

async function openExtensionMenuOverlay(event: MouseEvent) {
  await window.appApi.overlays.openExtensionMenu({ anchor: elementAnchor(event.currentTarget) });
}

async function openDownloadsBubbleOverlay(event: MouseEvent) {
  try {
    const anchor = elementAnchor(event.currentTarget);
    await browser.loadDownloads();
    browser.acknowledgeDownloads();
    await window.appApi.overlays.openDownloadsBubble({ anchor });
  } catch (error) {
    ElMessage.error(formatError(error));
  }
}

async function openAppMenuOverlay(event: MouseEvent) {
  await window.appApi.overlays.openAppMenu({ anchor: elementAnchor(event.currentTarget) });
}

function elementAnchor(target: EventTarget | null): BrowserRect {
  const element = target as HTMLElement | null;
  if (!element) {
    throw new Error('浮层锚点不存在');
  }

  const rect = element.getBoundingClientRect();
  if (!Number.isFinite(rect.left)
    || !Number.isFinite(rect.top)
    || !Number.isFinite(rect.width)
    || !Number.isFinite(rect.height)
    || rect.width <= 0
    || rect.height <= 0) {
    throw new Error('浮层锚点无效');
  }

  return {
    x: Math.round(rect.left),
    y: Math.round(rect.top),
    width: Math.round(rect.width),
    height: Math.round(rect.height),
  };
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

async function activateBrowserTab(tabId: string) {
  const tab = browser.openTabs.find((item) => item.id === tabId);
  if (!tab) {
    return;
  }

  await browser.activateOpenTab(tab);
  browser.scheduleBrowserBounds(browserHost.value, browserInsetLeft.value, browserInsetRight.value);
}

async function activateTopLevelTab(tab: TopLevelTab) {
  await activateBrowserTab(tab.type === 'site' ? tab.activeSessionTab.id : tab.tab.id);
}

async function activateSessionGroup(group: SiteSessionGroup) {
  await activateBrowserTab(group.activeTab.id);
}

async function closeBrowserTab(tabId: string) {
  await window.appApi.browser.closeTab(tabId);
  browser.scheduleBrowserBounds(browserHost.value, browserInsetLeft.value, browserInsetRight.value);
}

async function closeTopLevelTab(tab: TopLevelTab) {
  if (tab.type === 'direct') {
    await closeBrowserTab(tab.tab.id);
    return;
  }

  for (const sessionTab of siteTopLevelTabIds(tab)) {
    await window.appApi.browser.closeTab(sessionTab);
  }
  browser.scheduleBrowserBounds(browserHost.value, browserInsetLeft.value, browserInsetRight.value);
}

async function closeSessionGroup(group: SiteSessionGroup) {
  for (const tab of group.tabs) {
    await window.appApi.browser.closeTab(tab.id);
  }
  browser.scheduleBrowserBounds(browserHost.value, browserInsetLeft.value, browserInsetRight.value);
}

type DragLayer = 'top' | 'session' | 'page';
type TabDragPayload = {
  layer: DragLayer;
  tabIds: string[];
};

function tabDragPayload(layer: DragLayer, tabIds: string[]): string {
  return JSON.stringify({ layer, tabIds } satisfies TabDragPayload);
}

function startTabDrag(event: DragEvent, layer: DragLayer, tabIds: string[]) {
  if (!event.dataTransfer || !tabIds.length) {
    return;
  }

  activeDragPayload = { layer, tabIds };
  pendingDragOrderKey = '';
  event.dataTransfer.effectAllowed = 'move';
  event.dataTransfer.setData('application/x-jarvis-tabs', tabDragPayload(layer, tabIds));
}

function endTabDrag() {
  activeDragPayload = null;
  pendingDragOrderKey = '';
}

function startTopLevelDrag(event: DragEvent, tab: TopLevelTab) {
  startTabDrag(event, 'top', tab.type === 'site' ? siteTopLevelTabIds(tab) : [tab.tab.id]);
}

function startSessionGroupDrag(event: DragEvent, group: SiteSessionGroup) {
  startTabDrag(event, 'session', group.tabs.map((tab) => tab.id));
}

function startPageTabDrag(event: DragEvent, tab: SiteSessionTab) {
  startTabDrag(event, 'page', [tab.id]);
}

async function dropTopLevelTab(event: DragEvent, target: TopLevelTab) {
  event.preventDefault();
  endTabDrag();
}

async function dropSessionGroup(event: DragEvent, target: SiteSessionGroup) {
  event.preventDefault();
  endTabDrag();
}

async function dropPageTab(event: DragEvent, target: SiteSessionTab) {
  event.preventDefault();
  endTabDrag();
}

async function reorderDraggedTabs(event: DragEvent, layer: DragLayer, targetTabIds: string[]) {
  event.preventDefault();
  const draggedTabIds = activeDragPayload?.layer === layer ? activeDragPayload.tabIds : null;
  if (!draggedTabIds || !targetTabIds.length || targetTabIds.some((tabId) => draggedTabIds.includes(tabId))) {
    return;
  }

  const targetElement = event.currentTarget as HTMLElement | null;
  const targetRect = targetElement?.getBoundingClientRect();
  const placement = targetRect && event.clientX > targetRect.left + targetRect.width / 2 ? 'after' : 'before';
  const nextOrder = moveTabIds(browser.openTabs.map((tab) => tab.id), draggedTabIds, targetTabIds, placement);
  if (!nextOrder) {
    return;
  }

  const orderKey = nextOrder.join('|');
  if (orderKey === pendingDragOrderKey) {
    return;
  }

  pendingDragOrderKey = orderKey;
  await window.appApi.browser.reorderTabs(nextOrder);
}

function siteTopLevelTabIds(tab: Extract<TopLevelTab, { type: 'site' }>) {
  return tab.sessionGroups.flatMap((group) => group.tabs.map((sessionTab) => sessionTab.id));
}

function moveTabIds(order: string[], movingIds: string[], targetIds: string[], placement: 'before' | 'after') {
  const movingSet = new Set(movingIds);
  const remaining = order.filter((tabId) => !movingSet.has(tabId));
  const targetIndexes = targetIds
    .map((tabId) => remaining.indexOf(tabId))
    .filter((index) => index >= 0);
  if (!targetIndexes.length) {
    return null;
  }
  const targetIndex = placement === 'after'
    ? Math.max(...targetIndexes) + 1
    : Math.min(...targetIndexes);

  const next = [
    ...remaining.slice(0, targetIndex),
    ...movingIds,
    ...remaining.slice(targetIndex),
  ];
  return next.every((tabId, index) => tabId === order[index]) ? null : next;
}

async function openCurrentSessionCreator(site?: Site) {
  creatingSessionSite.value = site || browser.selectedSite;
  await setActivePanel('sessionCreator');
}

async function openTabPicker() {
  creatingSessionSite.value = browser.selectedSite;
  await togglePanel('tabPicker');
}

async function openPickerSessionCreator(site?: Site) {
  creatingSessionSite.value = site || null;
  await setActivePanel('sessionCreator');
}

function formatError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

onMounted(async () => {
  downloadActivityTimer = window.setInterval(() => {
    nowTick.value = Date.now();
  }, 500);
  await ensureSiteOpen();
  if (browserHost.value) {
    resizeObserver = new ResizeObserver(() => {
      browser.scheduleBrowserBounds(browserHost.value, browserInsetLeft.value, browserInsetRight.value);
    });
    resizeObserver.observe(browserHost.value);
  }
});

onBeforeUnmount(() => {
  resizeObserver?.disconnect();
  if (downloadActivityTimer !== undefined) {
    window.clearInterval(downloadActivityTimer);
  }
});

watch(
  () => [browserInsetLeft.value, browserInsetRight.value],
  ([insetLeft, insetRight]) => {
    browser.scheduleBrowserBounds(browserHost.value, insetLeft, insetRight);
  },
);

</script>

<template>
  <main class="chrome-shell">
    <section
      class="chrome-top"
      :class="{
        'chrome-top--with-session-tabs': hasSessionTabs,
        'chrome-top--with-page-tabs': hasPageTabs,
      }"
    >
      <div class="chrome-tabs" aria-label="标签栏">
        <button
          v-for="tab in topLevelTabs"
          :key="tab.key"
          class="chrome-tab"
          :class="{
            'chrome-tab--active': isTopLevelTabActive(tab),
            'chrome-tab--loading': isTopLevelTabLoading(tab),
            'chrome-tab--internal': tab.type === 'direct' && tab.tab.kind === 'internal',
            'chrome-tab--site-container': tab.type === 'site',
          }"
          type="button"
          draggable="true"
          @click="activateTopLevelTab(tab)"
          @dragstart="startTopLevelDrag($event, tab)"
          @dragend="endTabDrag"
          @dragover="reorderDraggedTabs($event, 'top', tab.type === 'site' ? siteTopLevelTabIds(tab) : [tab.tab.id])"
          @drop="dropTopLevelTab($event, tab)"
        >
          <Loading
            v-if="isTopLevelTabLoading(tab)"
            class="chrome-tab__loading"
            theme="outline"
            size="14"
          />
          <span v-else class="chrome-tab__icon">
            <Home v-if="tab.type === 'direct' && tab.tab.internalPageId === browser.homeTabId" theme="outline" size="14" />
            <Download v-else-if="tab.type === 'direct' && tab.tab.internalPageId === downloadsTabId" theme="outline" size="14" />
            <Setting v-else-if="tab.type === 'direct' && tab.tab.internalPageId === settingsTabId" theme="outline" size="14" />
            <Puzzle v-else-if="tab.type === 'direct' && tab.tab.internalPageId === extensionsTabId" theme="outline" size="14" />
            <Code v-else-if="tab.type === 'direct' && tab.tab.internalPageId === jarvisScriptTabId" theme="outline" size="14" />
            <Time v-else-if="tab.type === 'direct' && tab.tab.internalPageId === historyTabId" theme="outline" size="14" />
            <Delete v-else-if="tab.type === 'direct' && tab.tab.internalPageId === clearBrowsingDataTabId" theme="outline" size="14" />
            <img v-else-if="topLevelTabFavicon(tab)" :src="topLevelTabFavicon(tab)" alt="" />
            <span v-else>{{ topLevelTabInitial(tab) }}</span>
          </span>
          <span class="chrome-tab__title">{{ topLevelTabTitle(tab) }}</span>
          <Close class="chrome-tab__close" theme="outline" size="13" @click.stop="closeTopLevelTab(tab)" />
        </button>

        <button
          class="chrome-tab-add"
          :class="{ 'chrome-toolbar-button--active': activePanel === 'tabPicker' }"
          type="button"
          title="打开标签"
          @click="openTabPicker"
        >
          <AddOne theme="outline" size="18" />
        </button>
      </div>

      <div v-if="hasSessionTabs" class="chrome-session-tabs" aria-label="会话标签栏">
        <button
          v-for="group in activeSiteSessionGroups"
          :key="group.key"
          class="chrome-session-tab"
          :class="{
            'chrome-session-tab--active': group.session.id === browser.selectedSessionId,
            'chrome-session-tab--loading': isTabLoading(group.activeTab.id),
          }"
          type="button"
          draggable="true"
          @click="activateSessionGroup(group)"
          @dragstart="startSessionGroupDrag($event, group)"
          @dragend="endTabDrag"
          @dragover="reorderDraggedTabs($event, 'session', group.tabs.map((tab) => tab.id))"
          @drop="dropSessionGroup($event, group)"
        >
          <Loading
            v-if="isTabLoading(group.activeTab.id)"
            class="chrome-session-tab__loading"
            theme="outline"
            size="13"
          />
          <span v-else class="chrome-session-tab__icon">
            <img v-if="browser.siteIconSrc(group.site) || tabFaviconSrc(group.activeTab)" :src="browser.siteIconSrc(group.site) || tabFaviconSrc(group.activeTab)" alt="" />
            <span v-else>{{ browser.siteInitial(group.site) }}</span>
          </span>
          <span class="chrome-session-tab__title">{{ sessionGroupTitle(group) }}</span>
          <span v-if="group.tabs.length > 1" class="chrome-session-tab__count">{{ group.tabs.length }}</span>
          <Close class="chrome-session-tab__close" theme="outline" size="12" @click.stop="closeSessionGroup(group)" />
        </button>
      </div>

      <div v-if="hasPageTabs" class="chrome-page-tabs" aria-label="会话内标签栏">
        <button
          v-for="tab in activeSessionPageTabs"
          :key="tab.id"
          class="chrome-page-tab"
          :class="{
            'chrome-page-tab--active': tab.id === browser.activeTabId,
            'chrome-page-tab--loading': isTabLoading(tab.id),
          }"
          type="button"
          draggable="true"
          @click="activateBrowserTab(tab.id)"
          @dragstart="startPageTabDrag($event, tab)"
          @dragend="endTabDrag"
          @dragover="reorderDraggedTabs($event, 'page', [tab.id])"
          @drop="dropPageTab($event, tab)"
        >
          <Loading
            v-if="isTabLoading(tab.id)"
            class="chrome-page-tab__loading"
            theme="outline"
            size="12"
          />
          <span v-else class="chrome-page-tab__icon">
            <img v-if="tabFaviconSrc(tab)" :src="tabFaviconSrc(tab)" alt="" />
            <span v-else>{{ pageTabTitle(tab).trim().slice(0, 1).toUpperCase() }}</span>
          </span>
          <span class="chrome-page-tab__title">{{ pageTabTitle(tab) }}</span>
          <Close class="chrome-page-tab__close" theme="outline" size="12" @click.stop="closeBrowserTab(tab.id)" />
        </button>
      </div>

      <form
        class="chrome-toolbar"
        aria-label="浏览器工具栏"
        @submit.prevent="navigate"
      >
        <button type="button" title="后退" :disabled="isInternalPageActive || !browser.browserState.canGoBack" @click="browserAction('back')">
          <Left theme="outline" size="18" />
        </button>
        <button type="button" title="前进" :disabled="isInternalPageActive || !browser.browserState.canGoForward" @click="browserAction('forward')">
          <Right theme="outline" size="18" />
        </button>
        <button
          type="button"
          :disabled="isInternalPageActive"
          :title="browser.browserState.isLoading ? '停止' : '刷新'"
          @click="browser.browserState.isLoading ? browserAction('stop') : browserAction('reload')"
        >
          <Close v-if="browser.browserState.isLoading" theme="outline" size="17" />
          <Refresh v-else theme="outline" size="18" />
        </button>

        <div class="address-box" :class="{ 'address-box--with-session': currentSessionName }">
          <span class="address-box__status">
            {{ isHomeActive ? '起始页' : isDownloadsActive ? '下载' : isSettingsActive ? '设置' : browser.browserState.errorText ? '失败' : browser.browserState.isLoading ? '加载中' : '站点' }}
          </span>
          <span v-if="currentSessionName" class="address-box__session" :title="currentSessionName">
            <span class="address-box__session-dot" aria-hidden="true"></span>
            {{ currentSessionName }}
          </span>
          <input
            :value="displayedAddress"
            type="text"
            aria-label="地址栏"
            placeholder="输入网址"
            @input="browser.address = ($event.target as HTMLInputElement).value"
          />
        </div>

        <div class="chrome-toolbar-menu-wrap">
          <button
            type="button"
            title="扩展程序"
            @click="openExtensionMenuOverlay"
          >
            <Puzzle theme="outline" size="18" />
          </button>
        </div>

        <div class="chrome-toolbar-menu-wrap">
          <button
            class="chrome-download-button"
            type="button"
            title="下载内容"
            :class="{
              'chrome-download-button--active': downloadIndicatorCount > 0,
              'chrome-download-button--pulse': hasRecentDownloadActivity,
              'chrome-toolbar-button--active': isDownloadsActive,
            }"
            :style="{ '--download-progress-value': downloadProgress }"
            @click="openDownloadsBubbleOverlay"
          >
            <svg class="chrome-download-button__ring" viewBox="0 0 32 32" aria-hidden="true">
              <circle
                class="chrome-download-button__ring-track"
                cx="16"
                cy="16"
                r="11"
              />
              <circle
                class="chrome-download-button__ring-progress"
                cx="16"
                cy="16"
                r="11"
              />
            </svg>
            <Download theme="outline" size="18" />
            <span v-if="downloadIndicatorCount > 0" class="chrome-download-button__badge">{{ downloadIndicatorCount }}</span>
          </button>
        </div>

        <div class="chrome-toolbar-menu-wrap">
          <button
            type="button"
            title="更多"
            :class="{ 'chrome-toolbar-button--active': isSettingsActive }"
            @click="openAppMenuOverlay"
          >
            <More theme="outline" size="18" />
          </button>
        </div>
      </form>
    </section>

    <section ref="browserHost" class="browser-viewport">
      <SessionDrawer
        v-model="sessionDrawerVisible"
        :selected-url="selectedUrl"
        @create-session="openCurrentSessionCreator"
        @open-session="(_site, session) => openSessionFromDrawer(session)"
        @update:model-value="(visible) => syncPanelVisibility('sessionDrawer', visible)"
      />

      <SessionDrawer
        v-model="tabPickerVisible"
        selected-url=""
        show-site-picker
        @create-session="openPickerSessionCreator"
        @open-session="openSessionFromPicker"
        @open-sessions="openSessionsFromPicker"
        @update:model-value="(visible) => syncPanelVisibility('tabPicker', visible)"
      />

      <BrowserDrawer
        v-model="creatingSession"
        :title="creatingSessionTitle"
        width="320px"
        @update:model-value="(visible) => syncPanelVisibility('sessionCreator', visible)"
      >
        <form class="create-session-form" @submit.prevent="addSession">
          <ElInput v-model="newSessionName" placeholder="会话名称" clearable :disabled="creatingSessionSubmitting" />
          <ElButton native-type="submit" type="primary" :loading="creatingSessionSubmitting">
            <AddOne theme="outline" size="18" />
            创建
          </ElButton>
        </form>
      </BrowserDrawer>

    </section>
  </main>
</template>

<style scoped>
.chrome-top--with-session-tabs {
  grid-template-rows: var(--titlebar-height) 34px 48px;
}

.chrome-top--with-session-tabs.chrome-top--with-page-tabs {
  grid-template-rows: var(--titlebar-height) 34px 30px 48px;
}

.chrome-toolbar {
  grid-template-columns: repeat(3, 32px) minmax(220px, 1fr) repeat(3, 32px);
}

.chrome-tab--site-container {
  background: #d8dce3;
}

.chrome-tab.chrome-tab--active,
.chrome-tab.chrome-tab--site-container.chrome-tab--active {
  background: #ffffff;
  color: #202124;
}

.chrome-tab.chrome-tab--active {
  box-shadow: 0 1px 0 rgba(255, 255, 255, 0.92) inset;
}

.address-box--with-session {
  grid-template-columns: auto auto minmax(0, 1fr);
}

.address-box__session {
  display: inline-flex;
  height: 22px;
  align-items: center;
  flex: 0 0 auto;
  gap: 5px;
  border-radius: 999px;
  padding: 0 8px;
  background: #ffffff;
  color: #1a73e8;
  font-size: 12px;
  font-weight: 500;
  white-space: nowrap;
}

.address-box__session-dot {
  width: 6px;
  height: 6px;
  flex: 0 0 auto;
  border-radius: 50%;
  background: #1a73e8;
}

.chrome-session-tabs {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 4px;
  overflow-x: auto;
  overflow-y: hidden;
  border-top: 1px solid rgba(60, 64, 67, 0.08);
  padding: 3px 10px;
  background: #eef2f7;
  -webkit-app-region: drag;
  scrollbar-width: none;
}

.chrome-session-tabs::-webkit-scrollbar,
.chrome-page-tabs::-webkit-scrollbar {
  display: none;
}

.chrome-session-tab {
  position: relative;
  display: inline-flex;
  width: auto;
  min-width: 0;
  max-width: 188px;
  height: 28px;
  align-items: center;
  gap: 6px;
  flex: 0 0 auto;
  border: 1px solid rgba(139, 149, 169, 0.28);
  border-radius: 7px;
  padding: 0 8px;
  background: rgba(229, 234, 243, 0.66);
  color: #596274;
  text-align: left;
  -webkit-app-region: no-drag;
  box-shadow: 0 1px 0 rgba(255, 255, 255, 0.72) inset;
}

.chrome-session-tab:hover {
  background: rgba(255, 255, 255, 0.72);
  color: #30394f;
}

.chrome-session-tab--active {
  border-color: rgba(42, 115, 232, 0.62);
  background: #ffffff;
  color: #174ea6;
  box-shadow:
    0 1px 0 rgba(255, 255, 255, 0.94) inset,
    0 4px 12px rgba(42, 115, 232, 0.16);
}

.chrome-session-tab__loading {
  color: #5f6368;
  animation: tab-loading-spin 850ms linear infinite;
}

.chrome-session-tab__icon {
  display: inline-flex;
  width: 15px;
  height: 15px;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  flex: 0 0 auto;
  border-radius: 50%;
  background: #eef2f7;
  color: #5f6368;
  font-size: 9px;
  font-weight: 700;
}

.chrome-session-tab__icon img {
  width: 13px;
  height: 13px;
  object-fit: contain;
}

.chrome-session-tab__title {
  overflow: hidden;
  max-width: 126px;
  font-size: 12px;
  font-weight: 500;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.chrome-session-tab--active .chrome-session-tab__title {
  font-weight: 700;
}

.chrome-session-tab__count {
  display: inline-flex;
  min-width: 17px;
  height: 17px;
  align-items: center;
  justify-content: center;
  border-radius: 999px;
  padding: 0 5px;
  background: #dfe7f5;
  color: #4b5568;
  font-size: 10px;
  font-weight: 700;
}

.chrome-session-tab__close {
  display: inline-flex;
  width: 18px;
  height: 18px;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  color: #5f6368;
}

.chrome-session-tab__close:hover {
  background: #e8eaed;
}

.chrome-page-tabs {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 4px;
  overflow-x: auto;
  overflow-y: hidden;
  border-top: 1px solid rgba(60, 64, 67, 0.08);
  padding: 3px 10px;
  background: #f6f8fb;
  -webkit-app-region: drag;
  scrollbar-width: none;
}

.chrome-page-tab {
  display: inline-flex;
  width: auto;
  min-width: 0;
  max-width: 210px;
  height: 24px;
  align-items: center;
  gap: 6px;
  flex: 0 0 auto;
  border: 0;
  border-radius: 6px;
  padding: 0 7px;
  background: transparent;
  color: #4b5568;
  text-align: left;
  -webkit-app-region: no-drag;
}

.chrome-page-tab:hover {
  background: rgba(60, 64, 67, 0.08);
}

.chrome-page-tab--active {
  background: #e9eef7;
  color: #202124;
}

.chrome-page-tab__loading {
  color: #5f6368;
  animation: tab-loading-spin 850ms linear infinite;
}

.chrome-page-tab__icon {
  display: inline-flex;
  width: 14px;
  height: 14px;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  flex: 0 0 auto;
  border-radius: 50%;
  background: #ffffff;
  color: #647086;
  font-size: 8px;
  font-weight: 700;
}

.chrome-page-tab__icon img {
  width: 12px;
  height: 12px;
  object-fit: contain;
}

.chrome-page-tab__title {
  overflow: hidden;
  max-width: 150px;
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.chrome-page-tab__close {
  display: inline-flex;
  width: 18px;
  height: 18px;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  color: #667085;
}

.chrome-page-tab__close:hover {
  background: #dfe4ec;
}

.chrome-toolbar .chrome-toolbar-button--active,
.chrome-tab-add.chrome-toolbar-button--active {
  background: #d2e3fc;
  color: #174ea6;
}

.chrome-toolbar .chrome-toolbar-button--active:hover,
.chrome-tab-add.chrome-toolbar-button--active:hover {
  background: #c2d7f7;
}

.chrome-download-button {
  position: relative;
}

.chrome-download-button--active {
  color: #1a73e8;
}

.chrome-download-button--pulse {
  background: #e8f0fe;
}

.chrome-download-button__ring {
  position: absolute;
  inset: 0;
  width: 32px;
  height: 32px;
  opacity: 0;
  pointer-events: none;
  transition: opacity 160ms ease;
  transform: rotate(-90deg);
}

.chrome-download-button__ring-track,
.chrome-download-button__ring-progress {
  fill: none;
  stroke-width: 1.25;
  vector-effect: non-scaling-stroke;
}

.chrome-download-button__ring-track {
  stroke: #dfe8fb;
}

.chrome-download-button__ring-progress {
  stroke: #1a73e8;
  stroke-dasharray: 69.12;
  stroke-dashoffset: calc(69.12 - (69.12 * var(--download-progress-value, 0) / 100));
  stroke-linecap: round;
}

.chrome-download-button--active .chrome-download-button__ring {
  opacity: 1;
}

.chrome-download-button--pulse .chrome-download-button__ring {
  opacity: 1;
}

.chrome-download-button > .i-icon {
  position: relative;
  z-index: 1;
}

.chrome-download-button__badge {
  position: absolute;
  right: -1px;
  bottom: -1px;
  z-index: 2;
  display: inline-flex;
  min-width: 15px;
  height: 15px;
  align-items: center;
  justify-content: center;
  border: 2px solid #ffffff;
  border-radius: 999px;
  padding: 0 3px;
  background: #1a73e8;
  color: #ffffff;
  font-size: 10px;
  font-weight: 700;
  line-height: 1;
}

.chrome-toolbar-menu-wrap {
  position: relative;
  display: inline-flex;
  width: 32px;
  height: 32px;
  -webkit-app-region: no-drag;
}
</style>
