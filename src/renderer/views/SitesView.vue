<script setup lang="ts">
import { AddOne, Close, Globe, Search, Setting } from '@icon-park/vue-next';
import { ElButton, ElInput, ElMessage, ElSwitch } from 'element-plus';
import { computed, ref } from 'vue';
import type { Site, SiteSession } from '../../shared/types';
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
const sessionPickerSiteId = ref('');
const sessionPickerVisible = ref(false);

const frequentSites = computed(() => browser.sites.slice(0, 10));
const sessionPickerSite = computed(() => {
  return browser.sites.find((site) => site.id === sessionPickerSiteId.value) ?? null;
});
const sessionPickerSessions = computed(() => {
  const site = sessionPickerSite.value;
  if (!site) {
    return [];
  }

  return [...site.sessions].sort((left, right) => {
    return new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime();
  });
});

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
      openSessionPicker(site);
    }
    newSiteUrl.value = '';
    addDrawerVisible.value = false;
  } catch (error) {
    ElMessage.error(formatError(error));
  } finally {
    submitting.value = false;
  }
}

function openSessionPicker(site: Site) {
  sessionPickerSiteId.value = site.id;
  sessionPickerVisible.value = true;
}

function closeSessionPicker() {
  sessionPickerVisible.value = false;
  sessionPickerSiteId.value = '';
}

async function openPickedSession(session: SiteSession) {
  if (!sessionPickerSite.value) {
    return;
  }

  await browser.openSessionFromSite(sessionPickerSite.value, session);
  closeSessionPicker();
}

function openSiteSettings(site: Site) {
  settingsSiteId.value = site.id;
  settingsDrawerVisible.value = true;
}

async function createSessionForSettings(site: Site, name: string) {
  const sessionName = name.trim();
  if (!sessionName) {
    ElMessage.error('会话名称不能为空');
    return;
  }

  try {
    const session = await browser.addSessionToSite(site, sessionName);
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

  if (/^(https?:|file:|data:|jarvis-browser:)/i.test(value)) {
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
    <div class="start-page__background" aria-hidden="true"></div>
    <div class="start-page__scroll">
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
            @click="openSessionPicker(site)"
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
          <button class="site-card__main" type="button" @click="openSessionPicker(site)">
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
              <span>{{ site.extensions.length }} 个站点扩展程序</span>
            </span>
          </button>

          <button class="site-card__settings" type="button" title="站点设置" @click="openSiteSettings(site)">
            <Setting theme="outline" size="16" />
          </button>
        </article>
      </section>
    </div>

    <SessionDrawer
      v-model="settingsDrawerVisible"
      selected-url=""
      :settings-site-id="settingsSiteId"
      @create-session="createSessionForSettings"
      @open-session="browser.openSessionFromSite"
    />

    <Teleport to="body">
      <div
        v-if="sessionPickerVisible && sessionPickerSite"
        class="session-picker-overlay"
        role="presentation"
        @click.self="closeSessionPicker"
      >
        <section
          class="session-picker"
          role="dialog"
          aria-modal="true"
          :aria-label="`${siteDisplayTitle(sessionPickerSite)} 会话选择`"
        >
          <header class="session-picker__head">
            <span class="session-picker__icon">
              <img
                v-if="siteIconSrc(sessionPickerSite)"
                :src="siteIconSrc(sessionPickerSite)"
                alt=""
                @error="markIconFailed(sessionPickerSite.id)"
              />
              <span v-else class="site-fallback-icon">{{ siteInitial(sessionPickerSite) }}</span>
            </span>
            <span class="session-picker__title">
              <strong>{{ siteDisplayTitle(sessionPickerSite) }}</strong>
              <span>{{ sessionPickerSite.url }}</span>
            </span>
            <button class="session-picker__close" type="button" title="关闭" @click="closeSessionPicker">
              <Close theme="outline" size="18" />
            </button>
          </header>

          <div v-if="sessionPickerSessions.length" class="session-picker__list">
            <button
              v-for="session in sessionPickerSessions"
              :key="session.id"
              class="session-picker__item"
              type="button"
              @click="openPickedSession(session)"
            >
              <span>
                <strong>{{ session.name }}</strong>
                <small>{{ sessionPickerSite.url }}</small>
              </span>
            </button>
          </div>
          <p v-else class="session-picker__empty">这个站点还没有会话，请先在站点设置中创建会话。</p>
        </section>
      </div>
    </Teleport>

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

<style scoped>
.session-picker-overlay {
  position: fixed;
  inset: 0;
  z-index: 1200;
  display: grid;
  place-items: center;
  padding: 24px;
  background: rgba(22, 27, 44, 0.2);
  backdrop-filter: blur(10px);
}

.session-picker {
  display: flex;
  flex-direction: column;
  width: min(420px, 100%);
  max-height: calc(100vh - 48px);
  overflow: hidden;
  gap: 14px;
  border: 1px solid rgba(213, 221, 239, 0.9);
  border-radius: 12px;
  padding: 16px;
  background: rgba(255, 255, 255, 0.9);
  box-shadow:
    0 1px 0 rgba(255, 255, 255, 0.92) inset,
    0 28px 70px rgba(55, 67, 112, 0.22);
}

.session-picker__head {
  display: grid;
  grid-template-columns: 42px minmax(0, 1fr) 30px;
  align-items: center;
  gap: 12px;
}

.session-picker__icon {
  display: inline-flex;
  width: 42px;
  height: 42px;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  border-radius: 10px;
  background: #eef2ff;
  color: #30394f;
}

.session-picker__icon img {
  width: 26px;
  height: 26px;
  object-fit: contain;
}

.session-picker__title {
  display: grid;
  min-width: 0;
  gap: 4px;
}

.session-picker__title strong,
.session-picker__title span,
.session-picker__item strong,
.session-picker__item small {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.session-picker__title strong {
  color: #1f2637;
  font-size: 16px;
}

.session-picker__title span {
  color: #64718f;
  font-size: 12px;
}

.session-picker__close {
  display: inline-flex;
  width: 30px;
  height: 30px;
  align-items: center;
  justify-content: center;
  border: 0;
  border-radius: 50%;
  background: transparent;
  color: #64718f;
}

.session-picker__close:hover {
  background: rgba(239, 244, 255, 0.95);
  color: #27324a;
}

.session-picker__list {
  display: grid;
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  gap: 8px;
}

.session-picker__item {
  display: grid;
  min-width: 0;
  border: 1px solid rgba(213, 221, 239, 0.9);
  border-radius: 8px;
  padding: 12px;
  background: rgba(248, 250, 255, 0.72);
  color: inherit;
  text-align: left;
}

.session-picker__item:hover {
  border-color: rgba(104, 124, 242, 0.5);
  background: rgba(244, 247, 255, 0.96);
}

.session-picker__item span {
  display: grid;
  min-width: 0;
  gap: 4px;
}

.session-picker__item strong {
  color: #202a43;
  font-size: 14px;
}

.session-picker__item small {
  color: #687490;
  font-size: 12px;
}

.session-picker__empty {
  margin: 0;
  border: 1px dashed rgba(213, 221, 239, 0.96);
  border-radius: 8px;
  padding: 14px;
  color: #687490;
  font-size: 13px;
  text-align: center;
}
</style>
