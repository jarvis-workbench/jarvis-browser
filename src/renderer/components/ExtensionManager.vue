<script setup lang="ts">
import { Delete, FolderOpen, Plug, Search } from '@icon-park/vue-next';
import { ElButton, ElMessage, ElSwitch } from 'element-plus';
import { computed, onMounted, ref, watch } from 'vue';
import type { Site, SiteExtension } from '../../shared/types';

type ExtensionScope = 'global' | 'site';

const sites = ref<Site[]>([]);
const selectedScope = ref<ExtensionScope>('global');
const selectedSiteId = ref('');
const globalExtensions = ref<SiteExtension[]>([]);
const siteExtensions = ref<SiteExtension[]>([]);
const searchText = ref('');
const loading = ref(false);

const selectedSite = computed(() => sites.value.find((site) => site.id === selectedSiteId.value) ?? null);
const activeExtensions = computed(() => (
  selectedScope.value === 'global' ? globalExtensions.value : siteExtensions.value
));
const filteredExtensions = computed(() => filterExtensions(activeExtensions.value));
const installedCount = computed(() => globalExtensions.value.length + siteExtensions.value.length);
const enabledCount = computed(() => activeExtensions.value.filter((extension) => extension.enabled).length);
const pageTitle = computed(() => selectedScope.value === 'global' ? '全局扩展' : `${siteTitle(selectedSite.value)} 扩展`);
const pageHint = computed(() => selectedScope.value === 'global'
  ? '打开任意站点会话时加载'
  : '只在所选站点会话中加载');

onMounted(() => {
  void loadPage();
});

watch(selectedSiteId, (siteId) => {
  if (selectedScope.value === 'site') {
    void loadSiteExtensions(siteId);
  }
});

async function loadPage() {
  try {
    loading.value = true;
    const [nextSites, nextGlobalExtensions] = await Promise.all([
      window.appApi.sites.list(),
      window.appApi.extensions.listGlobal(),
    ]);
    sites.value = nextSites;
    globalExtensions.value = nextGlobalExtensions;
    if (!selectedSiteId.value && nextSites[0]) {
      selectedSiteId.value = nextSites[0].id;
    }
    if (selectedSiteId.value) {
      await loadSiteExtensions(selectedSiteId.value);
    }
  } catch (error) {
    ElMessage.error(formatError(error));
  } finally {
    loading.value = false;
  }
}

async function loadSiteExtensions(siteId: string) {
  siteExtensions.value = siteId ? await window.appApi.extensions.listSite(siteId) : [];
}

async function installGlobalExtension() {
  try {
    const extension = await window.appApi.extensions.installGlobal();
    if (extension) {
      globalExtensions.value = upsertExtension(globalExtensions.value, extension);
    }
  } catch (error) {
    ElMessage.error(formatError(error));
  }
}

async function installSiteExtension() {
  if (!selectedSiteId.value) {
    return;
  }

  try {
    const extension = await window.appApi.extensions.installSite(selectedSiteId.value);
    if (extension) {
      siteExtensions.value = upsertExtension(siteExtensions.value, extension);
      patchSiteExtension(selectedSiteId.value, extension);
    }
  } catch (error) {
    ElMessage.error(formatError(error));
  }
}

async function toggleExtension(extension: SiteExtension) {
  try {
    if (selectedScope.value === 'global') {
      const updated = extension.enabled
        ? await window.appApi.extensions.disableGlobal(extension.id)
        : await window.appApi.extensions.enableGlobal(extension.id);
      globalExtensions.value = upsertExtension(globalExtensions.value, updated);
      return;
    }

    if (!selectedSiteId.value) {
      return;
    }
    const updated = extension.enabled
      ? await window.appApi.extensions.disableSite(selectedSiteId.value, extension.id)
      : await window.appApi.extensions.enableSite(selectedSiteId.value, extension.id);
    siteExtensions.value = upsertExtension(siteExtensions.value, updated);
    patchSiteExtension(selectedSiteId.value, updated);
  } catch (error) {
    ElMessage.error(formatError(error));
  }
}

async function uninstallExtension(extension: SiteExtension) {
  try {
    if (selectedScope.value === 'global') {
      await window.appApi.extensions.uninstallGlobal(extension.id);
      globalExtensions.value = globalExtensions.value.filter((item) => item.id !== extension.id);
      return;
    }

    if (!selectedSiteId.value) {
      return;
    }
    await window.appApi.extensions.uninstallSite(selectedSiteId.value, extension.id);
    siteExtensions.value = siteExtensions.value.filter((item) => item.id !== extension.id);
    patchSiteExtensions(selectedSiteId.value, siteExtensions.value);
  } catch (error) {
    ElMessage.error(formatError(error));
  }
}

function selectGlobal() {
  selectedScope.value = 'global';
}

function selectSite(siteId: string) {
  selectedScope.value = 'site';
  selectedSiteId.value = siteId;
}

function filterExtensions(extensions: SiteExtension[]) {
  const keyword = searchText.value.trim().toLowerCase();
  if (!keyword) {
    return extensions;
  }

  return extensions.filter((extension) =>
    extension.name.toLowerCase().includes(keyword)
    || extension.version.toLowerCase().includes(keyword)
    || extension.permissions.some((permission) => permission.toLowerCase().includes(keyword)),
  );
}

function permissionText(extension: SiteExtension) {
  return extension.permissions.length ? `${extension.permissions.length} 项权限` : '无额外权限';
}

function siteTitle(site?: Site | null) {
  if (!site) {
    return '站点';
  }
  try {
    return site.title || new URL(site.url).hostname;
  } catch {
    return site.title || site.url;
  }
}

function upsertExtension(extensions: SiteExtension[], extension: SiteExtension) {
  return extensions.some((item) => item.id === extension.id)
    ? extensions.map((item) => (item.id === extension.id ? extension : item))
    : [...extensions, extension];
}

function patchSiteExtension(siteId: string, extension: SiteExtension) {
  const site = sites.value.find((item) => item.id === siteId);
  patchSiteExtensions(siteId, upsertExtension(site?.extensions ?? [], extension));
}

function patchSiteExtensions(siteId: string, extensions: SiteExtension[]) {
  sites.value = sites.value.map((site) => site.id === siteId ? { ...site, extensions } : site);
}

function formatError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
</script>

<template>
  <main class="extension-page">
    <aside class="extension-sidebar" aria-label="扩展程序分组">
      <button
        type="button"
        :class="{ 'extension-sidebar__item--active': selectedScope === 'global' }"
        class="extension-sidebar__item"
        @click="selectGlobal"
      >
        全局扩展
      </button>
      <span class="extension-sidebar__label">站点扩展</span>
      <button
        v-for="site in sites"
        :key="site.id"
        type="button"
        :class="{ 'extension-sidebar__item--active': selectedScope === 'site' && selectedSiteId === site.id }"
        class="extension-sidebar__item"
        @click="selectSite(site.id)"
      >
        {{ siteTitle(site) }}
      </button>
      <p v-if="!sites.length" class="drawer-empty">暂无站点</p>
    </aside>

    <section class="extension-panel">
      <header class="extension-panel__head extension-panel__head--page">
        <div>
          <strong>扩展程序管理</strong>
          <span>{{ pageTitle }} · {{ pageHint }}</span>
        </div>
        <ElButton :loading="loading" @click="loadPage">刷新</ElButton>
      </header>

      <label class="extension-search">
        <Search theme="outline" size="18" />
        <input v-model="searchText" type="search" placeholder="搜索扩展程序" />
      </label>

      <div class="extension-install-grid">
        <ElButton v-if="selectedScope === 'global'" type="primary" @click="installGlobalExtension">
          <FolderOpen theme="outline" size="16" />
          安装全局扩展程序
        </ElButton>
        <ElButton v-else type="primary" :disabled="!selectedSiteId" @click="installSiteExtension">
          <FolderOpen theme="outline" size="16" />
          安装到所选站点
        </ElButton>
      </div>

      <div class="extension-summary">
        <span>总计 <strong>{{ installedCount }}</strong> 个扩展程序</span>
        <span>当前分组启用 <strong>{{ enabledCount }}</strong> 个</span>
      </div>

      <article
        v-for="extension in filteredExtensions"
        :key="extension.id"
        class="extension-card"
        :class="{ 'extension-card--error': extension.loadError }"
      >
        <div class="extension-card__icon">
          <img v-if="extension.icon" :src="extension.icon" alt="" />
          <Plug v-else theme="outline" size="18" />
        </div>
        <div class="extension-card__main">
          <strong>{{ extension.name }}</strong>
          <span>{{ extension.loadError || permissionText(extension) }}</span>
          <p v-if="extension.loadError">{{ extension.loadError }}</p>
          <p v-else>
            <span>v{{ extension.version }}</span>
            <small>{{ selectedScope === 'global' ? '全局' : '站点' }}</small>
            <small v-if="extension.action?.defaultPopup">可弹出面板</small>
          </p>
        </div>
        <div class="extension-card__actions">
          <ElSwitch :model-value="extension.enabled" @change="toggleExtension(extension)" />
          <button class="extension-card__delete" type="button" title="卸载" @click="uninstallExtension(extension)">
            <Delete theme="outline" size="16" />
          </button>
        </div>
      </article>

      <p v-if="!filteredExtensions.length" class="drawer-empty">
        {{ activeExtensions.length ? '没有匹配的扩展程序' : '当前分组暂无扩展程序' }}
      </p>
    </section>
  </main>
</template>

<style scoped>
.extension-page {
  display: grid;
  height: 100%;
  grid-template-columns: 240px minmax(0, 1fr);
  gap: 24px;
  overflow: hidden;
  padding: 28px;
  background: #f8fafc;
}

.extension-sidebar,
.extension-panel {
  min-height: 0;
  overflow: auto;
}

.extension-sidebar {
  display: grid;
  align-content: start;
  gap: 6px;
  border-right: 1px solid #e4e7eb;
  padding-right: 16px;
}

.extension-sidebar__label {
  margin-top: 12px;
  padding: 0 10px;
  color: #5f6368;
  font-size: 12px;
}

.extension-sidebar__item {
  min-height: 34px;
  border: 0;
  border-radius: 6px;
  padding: 0 10px;
  background: transparent;
  color: #3c4043;
  text-align: left;
}

.extension-sidebar__item:hover,
.extension-sidebar__item--active {
  background: #e8f0fe;
  color: #174ea6;
}

.extension-panel {
  display: grid;
  align-content: start;
  gap: 14px;
}

.extension-panel__head {
  display: flex;
  justify-content: space-between;
  gap: 16px;
  border-bottom: 1px solid #edf0f2;
  padding-bottom: 10px;
}

.extension-panel__head--page {
  align-items: center;
}

.extension-panel__head div {
  display: grid;
  min-width: 0;
  gap: 4px;
}

.extension-panel__head strong {
  color: #202124;
  font-size: 15px;
}

.extension-panel__head span {
  overflow: hidden;
  color: #5f6368;
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.extension-search {
  display: grid;
  min-height: 38px;
  grid-template-columns: 22px minmax(0, 1fr);
  align-items: center;
  gap: 8px;
  border: 1px solid #dadce0;
  border-radius: 8px;
  padding: 0 12px;
  background: #ffffff;
  color: #5f6368;
}

.extension-search:focus-within {
  border-color: #8ab4f8;
}

.extension-search input {
  min-width: 0;
  border: 0;
  outline: 0;
  background: transparent;
  color: #202124;
  font-size: 13px;
}

.extension-install-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
}

.extension-summary {
  display: flex;
  min-height: 36px;
  align-items: center;
  gap: 14px;
  border: 1px solid #e4e7eb;
  border-radius: 8px;
  padding: 0 12px;
  background: #ffffff;
  color: #5f6368;
  font-size: 12px;
}

.extension-summary strong {
  color: #174ea6;
}

.extension-card {
  display: grid;
  min-width: 0;
  grid-template-columns: 44px minmax(0, 1fr) auto;
  align-items: center;
  gap: 12px;
  border: 1px solid #dadce0;
  border-radius: 8px;
  padding: 12px;
  background: #ffffff;
}

.extension-card--error {
  border-color: #f4c7c3;
  background: #fff8f7;
}

.extension-card__icon {
  display: inline-flex;
  width: 38px;
  height: 38px;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  border-radius: 8px;
  background: #f1f3f4;
  color: #3c4043;
}

.extension-card__icon img {
  width: 24px;
  height: 24px;
}

.extension-card__main {
  display: grid;
  min-width: 0;
  gap: 3px;
}

.extension-card__main strong,
.extension-card__main span,
.extension-card__main p {
  overflow: hidden;
  margin: 0;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.extension-card__main strong {
  color: #202124;
  font-size: 14px;
}

.extension-card__main > span,
.extension-card__main p {
  color: #5f6368;
  font-size: 12px;
}

.extension-card__main p {
  display: flex;
  align-items: center;
  gap: 8px;
}

.extension-card__main small {
  border-radius: 999px;
  padding: 1px 7px;
  background: #e8f0fe;
  color: #174ea6;
  font-size: 11px;
}

.extension-card__actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.extension-card__actions button {
  display: inline-flex;
  width: 28px;
  height: 28px;
  align-items: center;
  justify-content: center;
  border: 0;
  border-radius: 50%;
  background: transparent;
  color: #5f6368;
}

.extension-card__actions button:hover {
  background: #f1f3f4;
  color: #202124;
}

.extension-card__actions .extension-card__delete:hover {
  color: #d93025;
}
</style>
