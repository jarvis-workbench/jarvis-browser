<script setup lang="ts">
import { AddOne, Close, Globe, Refresh, Search, Setting } from '@icon-park/vue-next';
import { ElButton, ElInput, ElMessage, ElSwitch } from 'element-plus';
import { computed, ref } from 'vue';
import type { Site } from '../../shared/types';
import BrowserDrawer from '../components/BrowserDrawer.vue';
import SessionDrawer from '../components/SessionDrawer.vue';
import { useBrowserStore } from '../stores/browser';

const browser = useBrowserStore();
const addDrawerVisible = ref(false);
const newSiteUrl = ref('');
const newSessionName = ref('默认会话');
const createFirstSession = ref(true);
const submitting = ref(false);
const failedIconIds = ref(new Set<string>());
const settingsDrawerVisible = ref(false);
const settingsSiteId = ref('');

const frequentSites = computed(() => browser.sites.slice(0, 10));

function openAddDrawer(resetUrl = false) {
  if (resetUrl) {
    newSiteUrl.value = '';
  }
  newSessionName.value = '默认会话';
  createFirstSession.value = true;
  addDrawerVisible.value = true;
}

async function addSite(openAfterCreate = true) {
  try {
    submitting.value = true;
    const site = await browser.addSite(newSiteUrl.value);
    if (!site) {
      return;
    }
    if (createFirstSession.value) {
      await browser.addSessionToSite(site, newSessionName.value);
    }
    if (openAfterCreate) {
      await browser.openSite(site.id);
    }
    newSiteUrl.value = '';
    addDrawerVisible.value = false;
  } catch (error) {
    ElMessage.error(formatError(error));
  } finally {
    submitting.value = false;
  }
}

async function openSite(siteId: string) {
  await browser.openSite(siteId);
}

async function refreshSites() {
  try {
    failedIconIds.value = new Set();
    await browser.loadSites();
    ElMessage.success('站点已刷新');
  } catch (error) {
    ElMessage.error(formatError(error));
  }
}

function openSiteSettings(site: Site) {
  settingsSiteId.value = site.id;
  settingsDrawerVisible.value = true;
}

async function createSessionForSettings(site?: Site) {
  if (!site) {
    return;
  }

  try {
    const session = await browser.addSessionToSite(site);
    await browser.openSessionFromSite(site, session);
    settingsDrawerVisible.value = false;
    ElMessage.success('会话已创建');
  } catch (error) {
    ElMessage.error(formatError(error));
  }
}

function siteIconSrc(site: Site) {
  if (failedIconIds.value.has(site.id)) {
    return '';
  }

  return toImageSrc(site.faviconPath || site.faviconUrl);
}

function markIconFailed(siteId: string) {
  failedIconIds.value = new Set([...failedIconIds.value, siteId]);
}

function siteInitial(site: Site) {
  return siteDisplayTitle(site).trim().slice(0, 1).toUpperCase();
}

function siteDisplayTitle(site: Site) {
  return site.title || new URL(site.url).hostname;
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

function formatError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
</script>

<template>
  <main class="start-page">
    <header class="start-chrome-bar">
      <div class="start-chrome-bar__actions">
        <button type="button" title="刷新站点" @click="refreshSites">
          <Refresh theme="outline" size="18" />
        </button>
      </div>
    </header>

    <section class="chrome-start" aria-label="起始页">
      <h1>Jarvis</h1>
      <div class="chrome-start__search">
        <Search theme="outline" size="20" />
        <input v-model="newSiteUrl" type="text" placeholder="搜索或输入网址" />
      </div>

      <div class="chrome-shortcuts" aria-label="站点快捷方式">
        <button
          v-for="site in frequentSites"
          :key="site.id"
          class="chrome-shortcut"
          type="button"
          @click="openSite(site.id)"
        >
          <span class="chrome-shortcut__icon">
            <img v-if="siteIconSrc(site)" :src="siteIconSrc(site)" alt="" @error="markIconFailed(site.id)" />
            <span v-else class="site-fallback-icon">{{ siteInitial(site) }}</span>
          </span>
          <span class="chrome-shortcut__title">{{ siteDisplayTitle(site) }}</span>
        </button>

        <button class="chrome-shortcut chrome-shortcut--add" type="button" @click="openAddDrawer(true)">
          <span class="chrome-shortcut__icon">
            <AddOne theme="outline" size="24" />
          </span>
          <span class="chrome-shortcut__title">添加站点</span>
        </button>
      </div>
    </section>

    <section v-if="browser.sites.length" class="site-grid" aria-label="站点列表">
      <article v-for="site in browser.sites" :key="site.id" class="site-card">
        <button class="site-card__main" type="button" @click="openSite(site.id)">
          <span class="site-card__icon">
            <img v-if="siteIconSrc(site)" :src="siteIconSrc(site)" alt="" @error="markIconFailed(site.id)" />
            <span v-else class="site-fallback-icon">{{ siteInitial(site) }}</span>
          </span>
          <span class="site-card__content">
            <strong>{{ siteDisplayTitle(site) }}</strong>
            <span>{{ site.url }}</span>
          </span>
          <span class="site-card__meta">
            <span>{{ site.sessions.length }} 个会话</span>
            <span>{{ site.extensions.length }} 个站点插件</span>
          </span>
        </button>

        <button class="site-card__settings" type="button" title="站点设置" @click="openSiteSettings(site)">
          <Setting theme="outline" size="16" />
        </button>
      </article>
    </section>

    <SessionDrawer
      v-model="settingsDrawerVisible"
      selected-url=""
      :settings-site-id="settingsSiteId"
      @create-session="createSessionForSettings"
      @open-session="browser.openSessionFromSite"
    />

    <BrowserDrawer
      v-model="addDrawerVisible"
      title="添加站点"
      width="360px"
    >
      <form class="add-site-form" @submit.prevent="addSite(true)">
        <label class="form-field">
          <span>站点地址</span>
          <ElInput v-model="newSiteUrl" size="large" placeholder="输入站点地址" clearable>
            <template #prefix>
              <Globe theme="outline" size="18" />
            </template>
          </ElInput>
        </label>

        <div class="form-switch">
          <span>创建首个会话</span>
          <ElSwitch v-model="createFirstSession" />
        </div>

        <label v-if="createFirstSession" class="form-field">
          <span>会话名称</span>
          <ElInput v-model="newSessionName" size="large" placeholder="会话名称" clearable />
        </label>

        <div class="drawer-actions">
          <ElButton @click="addDrawerVisible = false">
            <Close theme="outline" size="16" />
            取消
          </ElButton>
          <ElButton native-type="submit" type="primary" :loading="submitting">
            <AddOne theme="outline" size="16" />
            添加并打开
          </ElButton>
        </div>
      </form>
    </BrowserDrawer>
  </main>
</template>
