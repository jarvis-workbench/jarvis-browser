<script setup lang="ts">
import { onBeforeUnmount, onMounted } from 'vue';
import { RouterView } from 'vue-router';
import { useBrowserStore } from './stores/browser';

const browser = useBrowserStore();
let unbindEvents: (() => void) | undefined;

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
});

onBeforeUnmount(() => {
  unbindEvents?.();
});
</script>

<template>
  <RouterView />
</template>
