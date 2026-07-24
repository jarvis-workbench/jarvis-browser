<script setup lang="ts">
import { Delete, FolderOpen, Plug, Search } from '@icon-park/vue-next';
import { ElButton, ElMessage, ElSwitch } from 'element-plus';
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import type { Site, SiteExtension } from '../../shared/types';
import { formatError } from '../../shared/utils';

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
  applySelectionFromLocation();
  void loadPage();
  window.addEventListener('popstate', handleLocationChange);
  window.addEventListener('hashchange', handleLocationChange);
});

onUnmounted(() => {
  window.removeEventListener('popstate', handleLocationChange);
  window.removeEventListener('hashchange', handleLocationChange);
});

watch(selectedSiteId, (siteId) => {
  if (selectedScope.value === 'site') {
    void loadSiteExtensions(siteId);
  }
});

function handleLocationChange() {
  applySelectionFromLocation();
  if (selectedScope.value === 'site' && selectedSiteId.value) {
    void loadSiteExtensions(selectedSiteId.value);
  }
}

function readSiteIdFromLocation() {
  try {
    return new URL(window.location.href).searchParams.get('site')?.trim() || '';
  } catch {
    return '';
  }
}

function applySelectionFromLocation(availableSites: Site[] = sites.value) {
  const siteFromUrl = readSiteIdFromLocation();
  if (siteFromUrl && availableSites.some((site) => site.id === siteFromUrl)) {
    selectedScope.value = 'site';
    selectedSiteId.value = siteFromUrl;
    return;
  }

  if (siteFromUrl && !availableSites.length) {
    // Sites not loaded yet; keep requested site id for later resolution.
    selectedScope.value = 'site';
    selectedSiteId.value = siteFromUrl;
    return;
  }

  selectedScope.value = 'global';
  if (!selectedSiteId.value || (siteFromUrl && selectedSiteId.value === siteFromUrl)) {
    selectedSiteId.value = availableSites[0]?.id ?? '';
  } else if (selectedSiteId.value && !availableSites.some((site) => site.id === selectedSiteId.value)) {
    selectedSiteId.value = availableSites[0]?.id ?? '';
  }
}

async function loadPage() {
  try {
    loading.value = true;
    const [nextSites, nextGlobalExtensions] = await Promise.all([
      window.appApi.sites.list(),
      window.appApi.extensions.listGlobal(),
    ]);
    sites.value = nextSites;
    globalExtensions.value = nextGlobalExtensions;
    applySelectionFromLocation(nextSites);
    if (selectedScope.value === 'site' && selectedSiteId.value) {
      await loadSiteExtensions(selectedSiteId.value);
    } else if (selectedSiteId.value) {
      // Prefetch first-site list so switching is instant, but keep global selected.
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
  syncLocationQuery(undefined);
}

function selectSite(siteId: string) {
  selectedScope.value = 'site';
  selectedSiteId.value = siteId;
  syncLocationQuery(siteId);
}

function syncLocationQuery(siteId?: string) {
  try {
    const next = new URL(window.location.href);
    if (siteId) {
      next.searchParams.set('site', siteId);
    } else {
      next.searchParams.delete('site');
    }
    const nextHref = next.toString();
    if (nextHref !== window.location.href) {
      window.history.replaceState(window.history.state, '', nextHref);
    }
  } catch {
    // Internal page URL sync is best-effort for address bar consistency.
  }
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

function siteInitial(site?: Site | null) {
  const title = siteTitle(site).trim();
  return title ? title.slice(0, 1).toUpperCase() : '站';
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


</script>

<template>
  <main class="extension-page">
    <section class="extension-page__body">
      <aside class="extension-sidebar" aria-label="扩展程序分组">
        <div class="extension-sidebar__heading">扩展程序</div>
        <button
          type="button"
          :class="{ 'extension-sidebar__item--active': selectedScope === 'global' }"
          class="extension-sidebar__item"
          @click="selectGlobal"
        >
          <span class="extension-sidebar__icon">
            <Plug theme="outline" size="14" />
          </span>
          <span class="extension-sidebar__text">全局扩展</span>
        </button>

        <div class="extension-sidebar__section">
          <span class="extension-sidebar__label">站点扩展</span>
          <button
            v-for="site in sites"
            :key="site.id"
            type="button"
            :class="{ 'extension-sidebar__item--active': selectedScope === 'site' && selectedSiteId === site.id }"
            class="extension-sidebar__item"
            @click="selectSite(site.id)"
          >
            <span class="extension-sidebar__icon extension-sidebar__icon--site">
              {{ siteInitial(site) }}
            </span>
            <span class="extension-sidebar__text">{{ siteTitle(site) }}</span>
          </button>
          <p v-if="!sites.length" class="extension-empty extension-empty--compact">暂无站点</p>
        </div>
      </aside>

      <section class="extension-panel">
        <header class="extension-panel__head">
          <div class="extension-panel__titles">
            <h1>扩展程序管理</h1>
            <p>{{ pageTitle }} · {{ pageHint }}</p>
          </div>
          <ElButton :loading="loading" @click="loadPage">刷新</ElButton>
        </header>

        <div class="extension-toolbar">
          <label class="extension-search">
            <Search theme="outline" size="16" />
            <input v-model="searchText" type="search" placeholder="搜索扩展程序" />
          </label>

          <ElButton v-if="selectedScope === 'global'" type="primary" @click="installGlobalExtension">
            <FolderOpen theme="outline" size="16" />
            安装全局扩展程序
          </ElButton>
          <ElButton v-else type="primary" :disabled="!selectedSiteId" @click="installSiteExtension">
            <FolderOpen theme="outline" size="16" />
            安装到所选站点
          </ElButton>
        </div>

        <div class="extension-summary" aria-label="扩展程序统计">
          <span class="extension-summary__item">
            总计
            <strong>{{ installedCount }}</strong>
            个扩展程序
          </span>
          <span class="extension-summary__item">
            当前分组启用
            <strong>{{ enabledCount }}</strong>
            个
          </span>
          <span class="extension-summary__item">
            当前显示
            <strong>{{ filteredExtensions.length }}</strong>
            个
          </span>
        </div>

        <div class="extension-list">
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
              <p v-if="extension.loadError" class="extension-card__error">{{ extension.loadError }}</p>
              <p v-else class="extension-card__meta">
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

          <p v-if="!filteredExtensions.length" class="extension-empty">
            {{ activeExtensions.length ? '没有匹配的扩展程序' : '当前分组暂无扩展程序' }}
          </p>
        </div>
      </section>
    </section>
  </main>
</template>

<style scoped>
.extension-page {
  height: 100%;
  overflow: auto;
  background: linear-gradient(180deg, #f8fafc 0%, #eef3f8 100%);
}

.extension-page__body {
  display: grid;
  width: min(1120px, 100%);
  min-height: 100%;
  grid-template-columns: 200px minmax(0, 1fr);
  gap: 28px;
  margin: 0 auto;
  padding: 32px 36px 44px;
  box-sizing: border-box;
}

.extension-sidebar {
  position: sticky;
  top: 32px;
  display: grid;
  align-content: start;
  align-self: start;
  gap: 2px;
  border: 1px solid #e3e8ef;
  border-radius: 8px;
  padding: 10px 8px 8px;
  background: rgba(255, 255, 255, 0.9);
  box-shadow: 0 1px 2px rgba(15, 23, 42, 0.04);
}

.extension-sidebar__heading {
  padding: 0 8px 6px;
  color: #80868b;
  font-size: 11px;
  font-weight: 500;
}

.extension-sidebar__section {
  display: grid;
  gap: 2px;
  margin-top: 6px;
  padding-top: 8px;
  border-top: 1px solid #edf0f2;
}

.extension-sidebar__label {
  padding: 0 8px 4px;
  color: #80868b;
  font-size: 11px;
  font-weight: 500;
}

.extension-sidebar__item {
  display: inline-flex;
  width: 100%;
  min-width: 0;
  height: 30px;
  align-items: center;
  gap: 8px;
  border: 0;
  border-radius: 6px;
  padding: 0 8px;
  background: transparent;
  color: #5f6368;
  font-size: 12px;
  font-weight: 400;
  line-height: 1.2;
  text-align: left;
  transition:
    background-color 0.16s ease,
    color 0.16s ease;
}

.extension-sidebar__item:hover {
  background: rgba(32, 33, 36, 0.05);
  color: #3c4043;
}

.extension-sidebar__item--active,
.extension-sidebar__item--active:hover {
  background: #e8f0fe;
  color: #174ea6;
  font-weight: 500;
}

.extension-sidebar__icon {
  display: inline-flex;
  width: 18px;
  height: 18px;
  flex: 0 0 18px;
  align-items: center;
  justify-content: center;
  border-radius: 4px;
  background: transparent;
  color: inherit;
  font-size: 10px;
  font-weight: 600;
  line-height: 1;
}

.extension-sidebar__icon--site {
  background: #f1f3f4;
  color: #80868b;
}

.extension-sidebar__item--active .extension-sidebar__icon {
  background: rgba(23, 78, 166, 0.1);
  color: #174ea6;
}

.extension-sidebar__text {
  min-width: 0;
  overflow: hidden;
  font-size: 12px;
  font-weight: inherit;
  line-height: 1.2;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.extension-panel {
  display: grid;
  align-content: start;
  gap: 16px;
  min-width: 0;
}

.extension-panel__head {
  display: flex;
  min-height: 40px;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}

.extension-panel__titles {
  display: grid;
  min-width: 0;
  gap: 4px;
}

.extension-panel__titles h1 {
  margin: 0;
  color: #202124;
  font-size: 24px;
  font-weight: 650;
  line-height: 1.2;
}

.extension-panel__titles p {
  margin: 0;
  overflow: hidden;
  color: #5f6368;
  font-size: 13px;
  line-height: 1.4;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.extension-toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px;
}

.extension-search {
  display: grid;
  min-height: 40px;
  min-width: 0;
  flex: 1 1 280px;
  grid-template-columns: 18px minmax(0, 1fr);
  align-items: center;
  gap: 10px;
  border: 1px solid #e3e8ef;
  border-radius: 8px;
  padding: 0 14px;
  background: rgba(255, 255, 255, 0.92);
  color: #5f6368;
  box-shadow: 0 1px 2px rgba(15, 23, 42, 0.03);
  transition:
    border-color 0.16s ease,
    box-shadow 0.16s ease;
}

.extension-search:focus-within {
  border-color: #8ab4f8;
  box-shadow:
    0 0 0 3px rgba(138, 180, 248, 0.22),
    0 1px 2px rgba(15, 23, 42, 0.03);
}

.extension-search input {
  min-width: 0;
  border: 0;
  outline: 0;
  background: transparent;
  color: #202124;
  font-size: 13px;
}

.extension-search input::placeholder {
  color: #80868b;
}

.extension-toolbar :deep(.el-button) {
  border-radius: 8px;
}

.extension-toolbar :deep(.el-button > span) {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.extension-summary {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
}

.extension-summary__item {
  display: inline-flex;
  min-height: 34px;
  align-items: center;
  gap: 6px;
  border: 1px solid #e3e8ef;
  border-radius: 999px;
  padding: 0 12px;
  background: rgba(255, 255, 255, 0.9);
  color: #5f6368;
  font-size: 12px;
  box-shadow: 0 1px 2px rgba(15, 23, 42, 0.03);
}

.extension-summary__item strong {
  color: #174ea6;
  font-size: 13px;
  font-weight: 650;
}

.extension-list {
  display: grid;
  gap: 10px;
}

.extension-card {
  display: grid;
  min-width: 0;
  grid-template-columns: 44px minmax(0, 1fr) auto;
  align-items: center;
  gap: 14px;
  border: 1px solid #e3e8ef;
  border-radius: 8px;
  padding: 14px 16px;
  background: rgba(255, 255, 255, 0.94);
  box-shadow: 0 1px 2px rgba(15, 23, 42, 0.04);
  transition:
    border-color 0.16s ease,
    box-shadow 0.16s ease;
}

.extension-card:hover {
  border-color: #d4dce7;
  box-shadow: 0 4px 14px rgba(15, 23, 42, 0.06);
}

.extension-card--error {
  border-color: #f4c7c3;
  background: #fff8f7;
}

.extension-card__icon {
  display: inline-flex;
  width: 40px;
  height: 40px;
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
  object-fit: contain;
}

.extension-card__main {
  display: grid;
  min-width: 0;
  gap: 4px;
}

.extension-card__main strong,
.extension-card__main > span,
.extension-card__meta {
  overflow: hidden;
  margin: 0;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.extension-card__main strong {
  color: #202124;
  font-size: 14px;
  font-weight: 600;
  line-height: 1.3;
}

.extension-card__main > span {
  color: #5f6368;
  font-size: 12px;
  line-height: 1.4;
}

.extension-card__meta {
  display: flex;
  align-items: center;
  gap: 8px;
  color: #5f6368;
  font-size: 12px;
}

.extension-card__meta small {
  border-radius: 999px;
  padding: 1px 8px;
  background: #e8f0fe;
  color: #174ea6;
  font-size: 11px;
  font-weight: 500;
  line-height: 1.4;
}

.extension-card__error {
  margin: 0;
  overflow: hidden;
  color: #c5221f;
  font-size: 12px;
  line-height: 1.4;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.extension-card__actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.extension-card__delete {
  display: inline-flex;
  width: 30px;
  height: 30px;
  align-items: center;
  justify-content: center;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: #5f6368;
  transition:
    background-color 0.16s ease,
    color 0.16s ease;
}

.extension-card__delete:hover {
  background: #fce8e6;
  color: #d93025;
}

.extension-empty {
  margin: 0;
  border: 1px dashed #d7dee8;
  border-radius: 8px;
  padding: 28px 18px;
  background: rgba(255, 255, 255, 0.72);
  color: #5f6368;
  font-size: 13px;
  text-align: center;
}

.extension-empty--compact {
  padding: 12px 10px;
  font-size: 12px;
}

.extension-panel__head :deep(.el-button) {
  border-radius: 8px;
}

@media (max-width: 1120px) {
  .extension-page__body {
    width: min(100%, 1120px);
    grid-template-columns: 180px minmax(0, 1fr);
    gap: 20px;
    padding: 26px 28px 38px;
  }

  .extension-sidebar {
    top: 26px;
  }
}
</style>
