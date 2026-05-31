<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted } from 'vue';
import { RouterView, useRoute } from 'vue-router';
import ExtensionManager from './components/ExtensionManager.vue';
import JarvisScriptManager from './components/JarvisScriptManager.vue';
import SessionSyncDialog from './components/SessionSyncDialog.vue';
import { useBrowserStore } from './stores/browser';
import ClearBrowsingDataView from './views/ClearBrowsingDataView.vue';
import DownloadsView from './views/DownloadsView.vue';
import HistoryView from './views/HistoryView.vue';
import SettingsView from './views/SettingsView.vue';
import SitesView from './views/SitesView.vue';

const browser = useBrowserStore();
const route = useRoute();
let unbindEvents: (() => void) | undefined;

const injectedInternalPage = (
  window as Window & { __JARVIS_INTERNAL_PAGE__?: string }
).__JARVIS_INTERNAL_PAGE__;

const internalPageComponent = computed(() => {
  const pageId = injectedInternalPage || route.name;
  if (pageId === 'newtab') {
    return SitesView;
  }

  if (pageId === 'downloads') {
    return DownloadsView;
  }

  if (pageId === 'settings') {
    return SettingsView;
  }

  if (pageId === 'extensions') {
    return ExtensionManager;
  }

  if (pageId === 'jarvis-script') {
    return JarvisScriptManager;
  }

  if (pageId === 'history') {
    return HistoryView;
  }

  if (pageId === 'clear-browsing-data') {
    return ClearBrowsingDataView;
  }

  return undefined;
});

function applyWindowChromeVariables() {
  const chrome = window.appApi.windowChrome;
  const root = document.documentElement;
  root.dataset.platform = chrome.platform;
  root.style.setProperty('--titlebar-height', `${chrome.titlebarHeight}px`);
  root.style.setProperty('--titlebar-left-inset', `${chrome.titlebarLeftInset}px`);
  root.style.setProperty('--titlebar-right-inset', `${chrome.titlebarRightInset}px`);
  root.style.setProperty('--capsule-width', `${chrome.capsuleWidth}px`);
  root.style.setProperty('--capsule-gap', `${chrome.capsuleGap}px`);
}

onMounted(async () => {
  applyWindowChromeVariables();
  unbindEvents = browser.bindEvents();
  await browser.loadSites();
  await browser.loadDownloads();
  await browser.loadSettings();
});

onBeforeUnmount(() => {
  unbindEvents?.();
});
</script>

<template>
  <component :is="internalPageComponent" v-if="internalPageComponent" />
  <RouterView v-else />
  <SessionSyncDialog
    :model-value="browser.sessionSyncDialog.visible"
    :scope="browser.sessionSyncDialog.scope"
    :site-id="browser.sessionSyncDialog.siteId"
    @update:model-value="(visible) => visible ? null : browser.closeSessionSyncDialog()"
  />
</template>
