<script setup lang="ts">
import {
  AddOne,
  Close,
  Code,
  Home,
  Left,
  Loading,
  Plug,
  Refresh,
  Right,
  Time,
} from '@icon-park/vue-next';
import {
  ElButton,
  ElInput,
  ElMessage,
} from 'element-plus';
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { Site, SiteSession } from '../../shared/types';
import BrowserDrawer from '../components/BrowserDrawer.vue';
import ExtensionManager from '../components/ExtensionManager.vue';
import JarvisScriptManager from '../components/JarvisScriptManager.vue';
import SessionDrawer from '../components/SessionDrawer.vue';
import { useBrowserStore } from '../stores/browser';
import SitesView from './SitesView.vue';

const browser = useBrowserStore();
const browserHost = ref<HTMLElement | null>(null);
type ActivePanel = 'tabPicker' | 'sessionDrawer' | 'extensionManager' | 'scriptManager' | 'sessionCreator' | null;
const activePanel = ref<ActivePanel>(null);
const sessionDrawerVisible = ref(false);
const tabPickerVisible = ref(false);
const extensionManagerVisible = ref(false);
const scriptManagerVisible = ref(false);
const creatingSession = ref(false);
const creatingSessionSubmitting = ref(false);
const newSessionName = ref('');
const creatingSessionSite = ref<Site | null>(null);

let resizeObserver: ResizeObserver | undefined;

const selectedUrl = computed(() => browser.browserState.displayUrl || browser.browserState.url || browser.selectedSite?.url || '');
const selectedSessionName = computed(() => browser.selectedSession?.name ?? '');
const isHomeActive = computed(() => browser.activeTabId === browser.homeTabId);
const showSessionName = computed(() => !isHomeActive.value && Boolean(selectedSessionName.value));
const browserInsetLeft = computed(() => 0);
const browserInsetRight = computed(() => {
  if (isHomeActive.value) {
    return 0;
  }

  return Math.max(
    sessionDrawerVisible.value || tabPickerVisible.value ? 360 : 0,
    creatingSession.value ? 320 : 0,
    extensionManagerVisible.value ? 420 : 0,
    scriptManagerVisible.value ? 420 : 0,
  );
});
const creatingSessionTitle = computed(() => (
  creatingSessionSite.value ? `新建会话 - ${creatingSessionSite.value.title}` : '新建会话'
));

async function setActivePanel(panel: ActivePanel) {
  activePanel.value = panel;
  tabPickerVisible.value = panel === 'tabPicker';
  sessionDrawerVisible.value = panel === 'sessionDrawer';
  extensionManagerVisible.value = panel === 'extensionManager';
  scriptManagerVisible.value = panel === 'scriptManager';
  creatingSession.value = panel === 'sessionCreator';
  await browser.setBrowserBounds(browserHost.value, browserInsetLeft.value, browserInsetRight.value);
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
  const initialTabId = browser.activeTabId;
  if (!browser.sites.length) {
    await browser.loadSites();
  }

  if (initialTabId === browser.homeTabId && browser.activeTabId === browser.homeTabId) {
    await browser.activateHome();
  }

  await nextTick();
  await browser.setBrowserBounds(browserHost.value, browserInsetLeft.value, browserInsetRight.value);
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
    await browser.setBrowserBounds(browserHost.value, browserInsetLeft.value, browserInsetRight.value);
  } catch (error) {
    ElMessage.error(formatError(error));
  } finally {
    creatingSessionSubmitting.value = false;
  }
}

function isSessionLoading(session: SiteSession) {
  return Boolean(browser.getTabState(session.id)?.isLoading);
}

async function openSession(site: Site, session: SiteSession) {
  try {
    await browser.activateOpenTab({ site, session });
    await browser.setBrowserBounds(browserHost.value, browserInsetLeft.value, browserInsetRight.value);
  } catch (error) {
    ElMessage.error(formatError(error));
  }
}

async function refreshScriptManager(siteId: string | null) {
  if (!scriptManagerVisible.value || !siteId) {
    return;
  }

  await browser.loadScripts(siteId);
}

async function openSessionFromDrawer(session: SiteSession) {
  try {
    await browser.openSessionFromCurrentSite(session);
    await setActivePanel(null);
    await browser.setBrowserBounds(browserHost.value, browserInsetLeft.value, browserInsetRight.value);
  } catch (error) {
    ElMessage.error(formatError(error));
  }
}

async function openSessionFromPicker(site: Site, session: SiteSession) {
  try {
    await browser.openSessionFromSite(site, session);
    await setActivePanel(null);
    await browser.setBrowserBounds(browserHost.value, browserInsetLeft.value, browserInsetRight.value);
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

async function closeSessionTab(site: Site, session: SiteSession) {
  try {
    await browser.closeSessionTab(site, session);
    await browser.setBrowserBounds(browserHost.value, browserInsetLeft.value, browserInsetRight.value);
  } catch (error) {
    ElMessage.error(formatError(error));
  }
}

async function goHome() {
  await setActivePanel(null);
  await browser.activateHome();
}

async function openExtensionManager() {
  await togglePanel('extensionManager');
}

async function openScriptManager() {
  try {
    if (activePanel.value !== 'scriptManager' && browser.selectedSite) {
      await browser.loadScripts(browser.selectedSite.id);
    }
    await togglePanel('scriptManager');
  } catch (error) {
    ElMessage.error(formatError(error));
  }
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
  await ensureSiteOpen();
  if (browserHost.value) {
    resizeObserver = new ResizeObserver(() => {
      void browser.setBrowserBounds(browserHost.value, browserInsetLeft.value, browserInsetRight.value);
    });
    resizeObserver.observe(browserHost.value);
  }
});

onBeforeUnmount(() => {
  resizeObserver?.disconnect();
});

watch(
  () => browser.selectedSessionId,
  async () => {
    await browser.refreshBounds(browserHost.value, browserInsetLeft.value, browserInsetRight.value);
  },
);

watch(
  () => [browserInsetLeft.value, browserInsetRight.value],
  async ([insetLeft, insetRight]) => {
    await browser.refreshBounds(browserHost.value, insetLeft, insetRight);
  },
);

watch(
  () => extensionManagerVisible.value,
  async (visible) => {
    if (!visible) {
      await browser.refreshBounds(browserHost.value, browserInsetLeft.value, browserInsetRight.value);
    }
  },
);

watch(
  () => scriptManagerVisible.value,
  async (visible) => {
    if (!visible) {
      await browser.refreshBounds(browserHost.value, browserInsetLeft.value, browserInsetRight.value);
    } else if (browser.selectedSiteId) {
      await refreshScriptManager(browser.selectedSiteId);
    }
  },
);

watch(
  () => browser.selectedSiteId,
  async (siteId) => {
    await refreshScriptManager(siteId);
  },
);
</script>

<template>
  <main class="chrome-shell">
    <section class="chrome-top">
      <div class="chrome-tabs" aria-label="标签栏">
        <button
          class="chrome-tab chrome-tab--home"
          :class="{ 'chrome-tab--active': isHomeActive }"
          type="button"
          @click="goHome"
        >
          <Home theme="outline" size="14" />
          <span class="chrome-tab__title">起始页</span>
        </button>

        <button
          v-for="tab in browser.openSessionTabs"
          :key="tab.id"
          class="chrome-tab"
          :class="{
            'chrome-tab--active': tab.id === browser.activeTabId,
            'chrome-tab--loading': isSessionLoading(tab.session),
          }"
          type="button"
          @click="openSession(tab.site, tab.session)"
        >
          <Loading
            v-if="isSessionLoading(tab.session)"
            class="chrome-tab__loading"
            theme="outline"
            size="14"
          />
          <span v-else class="chrome-tab__icon">
            <img v-if="browser.siteIconSrc(tab.site)" :src="browser.siteIconSrc(tab.site)" alt="" />
            <span v-else>{{ browser.siteInitial(tab.site) }}</span>
          </span>
          <span class="chrome-tab__title">{{ browser.tabDisplayTitle(tab.session) }}</span>
          <Close class="chrome-tab__close" theme="outline" size="13" @click.stop="closeSessionTab(tab.site, tab.session)" />
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

      <form
        class="chrome-toolbar"
        :class="{ 'chrome-toolbar--without-session': !showSessionName }"
        aria-label="浏览器工具栏"
        @submit.prevent="navigate"
      >
        <button type="button" title="后退" :disabled="isHomeActive || !browser.browserState.canGoBack" @click="browserAction('back')">
          <Left theme="outline" size="18" />
        </button>
        <button type="button" title="前进" :disabled="isHomeActive || !browser.browserState.canGoForward" @click="browserAction('forward')">
          <Right theme="outline" size="18" />
        </button>
        <button
          type="button"
          :disabled="isHomeActive"
          :title="browser.browserState.isLoading ? '停止' : '刷新'"
          @click="browser.browserState.isLoading ? browserAction('stop') : browserAction('reload')"
        >
          <Close v-if="browser.browserState.isLoading" theme="outline" size="17" />
          <Refresh v-else theme="outline" size="18" />
        </button>

        <div
          v-if="showSessionName"
          class="chrome-session-name"
          :title="selectedSessionName"
        >
          <span class="chrome-session-name__dot"></span>
          <span class="chrome-session-name__text">{{ selectedSessionName }}</span>
        </div>

        <div class="address-box">
          <span class="address-box__status">
            {{ isHomeActive ? '起始页' : browser.browserState.errorText ? '失败' : browser.browserState.isLoading ? '加载中' : '站点' }}
          </span>
          <input v-model="browser.address" type="text" aria-label="地址栏" placeholder="输入网址" :disabled="isHomeActive" />
        </div>

        <button
          type="button"
          title="Jarvis 脚本"
          :class="{ 'chrome-toolbar-button--active': activePanel === 'scriptManager' }"
          :disabled="isHomeActive"
          @click="openScriptManager"
        >
          <Code theme="outline" size="18" />
        </button>
        <button
          type="button"
          title="插件管理"
          :class="{ 'chrome-toolbar-button--active': activePanel === 'extensionManager' }"
          :disabled="isHomeActive"
          @click="openExtensionManager"
        >
          <Plug theme="outline" size="18" />
        </button>
        <button
          type="button"
          title="会话管理"
          :class="{ 'chrome-toolbar-button--active': activePanel === 'sessionDrawer' }"
          :disabled="isHomeActive"
          @click="togglePanel('sessionDrawer')"
        >
          <Time theme="outline" size="18" />
        </button>
      </form>
    </section>

    <section ref="browserHost" class="browser-viewport">
      <SitesView v-if="isHomeActive" />
      <div v-else-if="!browser.selectedSession" class="browser-placeholder">
        <p>当前站点还没有会话</p>
        <ElButton type="primary" @click="openCurrentSessionCreator()">
          <AddOne theme="outline" size="18" />
          新建会话
        </ElButton>
      </div>
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
        @update:model-value="(visible) => syncPanelVisibility('tabPicker', visible)"
      />

      <ExtensionManager
        v-model="extensionManagerVisible"
        @update:model-value="(visible) => syncPanelVisibility('extensionManager', visible)"
      />
      <JarvisScriptManager
        v-model="scriptManagerVisible"
        @update:model-value="(visible) => syncPanelVisibility('scriptManager', visible)"
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
.chrome-toolbar {
  grid-template-columns: repeat(3, 32px) minmax(36px, max-content) minmax(220px, 1fr) repeat(3, 32px);
}

.chrome-toolbar--without-session {
  grid-template-columns: repeat(3, 32px) minmax(220px, 1fr) repeat(3, 32px);
}

.chrome-session-name {
  display: inline-flex;
  min-width: 36px;
  height: 24px;
  align-items: center;
  gap: 6px;
  align-self: center;
  justify-self: start;
  border: 1px solid #dadce0;
  border-radius: 999px;
  padding: 0 9px;
  background: #ffffff;
  color: #3c4043;
  font-size: 12px;
  font-weight: 500;
  box-shadow: 0 1px 2px rgba(60, 64, 67, 0.08);
  -webkit-app-region: no-drag;
}

.chrome-session-name__dot {
  width: 6px;
  height: 6px;
  flex: 0 0 auto;
  border-radius: 50%;
  background: #1a73e8;
}

.chrome-session-name__text {
  flex: 0 0 auto;
  white-space: nowrap;
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
</style>
