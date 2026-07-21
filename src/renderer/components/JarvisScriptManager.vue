<script setup lang="ts">
import { Code, Delete, Play } from '@icon-park/vue-next';
import { ElButton, ElMessage, ElMessageBox, ElSwitch } from 'element-plus';
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { JarvisScript, Site } from '../../shared/types';
import { formatError } from '../../shared/utils';

type ScriptScope = 'global' | 'site';

const sites = ref<Site[]>([]);
const selectedScope = ref<ScriptScope>('global');
const selectedSiteId = ref('');
const globalScripts = ref<JarvisScript[]>([]);
const siteScripts = ref<JarvisScript[]>([]);
const loading = ref(false);
let unbindScriptUpdates: (() => void) | undefined;

const selectedSite = computed(() => sites.value.find((site) => site.id === selectedSiteId.value) ?? null);
const activeScripts = computed(() => selectedScope.value === 'global' ? globalScripts.value : siteScripts.value);
const installedCount = computed(() => globalScripts.value.length + siteScripts.value.length);
const enabledCount = computed(() => activeScripts.value.filter((script) => script.runtimeState.enabled).length);
const runningCount = computed(() => activeScripts.value.filter((script) => isRunning(script)).length);
const pageTitle = computed(() => selectedScope.value === 'global' ? '全局 jarvis-script' : `${siteTitle(selectedSite.value)} jarvis-script`);
const pageHint = computed(() => selectedScope.value === 'global'
  ? '打开任意站点会话时可用'
  : '只在所选站点会话中可用');

onMounted(() => {
  unbindScriptUpdates = window.appApi.onJarvisScriptUpdated((siteId, scripts) => {
    if (!siteId) {
      globalScripts.value = scripts;
      return;
    }
    if (siteId === selectedSiteId.value) {
      siteScripts.value = scripts;
    }
    patchSiteScripts(siteId, scripts);
  });
  void loadPage();
});

onBeforeUnmount(() => {
  unbindScriptUpdates?.();
});

watch(selectedSiteId, (siteId) => {
  if (selectedScope.value === 'site') {
    void loadSiteScripts(siteId);
  }
});

async function loadPage() {
  try {
    loading.value = true;
    const [nextSites, nextGlobalScripts] = await Promise.all([
      window.appApi.sites.list(),
      window.appApi.jarvisScripts.listGlobal(),
    ]);
    sites.value = nextSites;
    globalScripts.value = nextGlobalScripts;
    if (!selectedSiteId.value && nextSites[0]) {
      selectedSiteId.value = nextSites[0].id;
    }
    if (selectedSiteId.value) {
      await loadSiteScripts(selectedSiteId.value);
    }
  } catch (error) {
    ElMessage.error(formatError(error));
  } finally {
    loading.value = false;
  }
}

async function loadSiteScripts(siteId: string) {
  siteScripts.value = siteId ? await window.appApi.jarvisScripts.listSite(siteId) : [];
}

async function installGlobalScript() {
  try {
    const script = await window.appApi.jarvisScripts.installGlobal();
    if (script) {
      globalScripts.value = upsertScript(globalScripts.value, script);
    }
  } catch (error) {
    ElMessage.error(formatError(error));
  }
}

async function installSiteScript() {
  if (!selectedSiteId.value) {
    return;
  }

  try {
    const script = await window.appApi.jarvisScripts.installSite(selectedSiteId.value);
    if (script) {
      siteScripts.value = upsertScript(siteScripts.value, script);
      patchSiteScript(selectedSiteId.value, script);
    }
  } catch (error) {
    ElMessage.error(formatError(error));
  }
}

async function toggleScript(script: JarvisScript) {
  try {
    if (selectedScope.value === 'global') {
      const updated = script.runtimeState.enabled
        ? await window.appApi.jarvisScripts.disableGlobal(script.id)
        : await window.appApi.jarvisScripts.enableGlobal(script.id);
      globalScripts.value = upsertScript(globalScripts.value, updated);
      return;
    }

    if (!selectedSiteId.value) {
      return;
    }
    const updated = script.runtimeState.enabled
      ? await window.appApi.jarvisScripts.disableSite(selectedSiteId.value, script.id)
      : await window.appApi.jarvisScripts.enableSite(selectedSiteId.value, script.id);
    siteScripts.value = upsertScript(siteScripts.value, updated);
    patchSiteScript(selectedSiteId.value, updated);
  } catch (error) {
    ElMessage.error(formatError(error));
  }
}

async function uninstallScript(script: JarvisScript) {
  try {
    await ElMessageBox.confirm(`确认卸载「${script.name}」吗？`, '卸载 jarvis-script', {
      confirmButtonText: '确认卸载',
      cancelButtonText: '取消',
      type: 'warning',
    });
    if (selectedScope.value === 'global') {
      await window.appApi.jarvisScripts.uninstallGlobal(script.id);
      globalScripts.value = globalScripts.value.filter((item) => item.id !== script.id);
      return;
    }
    if (!selectedSiteId.value) {
      return;
    }
    await window.appApi.jarvisScripts.uninstallSite(selectedSiteId.value, script.id);
    siteScripts.value = siteScripts.value.filter((item) => item.id !== script.id);
    patchSiteScripts(selectedSiteId.value, siteScripts.value);
  } catch (error) {
    if (error !== 'cancel') {
      ElMessage.error(formatError(error));
    }
  }
}

function selectGlobal() {
  selectedScope.value = 'global';
}

function selectSite(siteId: string) {
  selectedScope.value = 'site';
  selectedSiteId.value = siteId;
}

function scriptStatus(script: JarvisScript) {
  if (!script.runtimeState.enabled) {
    return '已停用';
  }
  if (script.runtimeState.loadError) {
    return '异常';
  }
  return isRunning(script) ? '运行中' : '已启用';
}

function scriptError(script: JarvisScript) {
  return script.runtimeState.loadError || '';
}

function isRunning(script: JarvisScript) {
  const startedAt = script.runtimeState.lastStartedAt;
  const stoppedAt = script.runtimeState.lastStoppedAt;
  return Boolean(startedAt && (!stoppedAt || startedAt > stoppedAt));
}

function scriptDetail(script: JarvisScript) {
  if (script.description) {
    return script.description;
  }
  if (script.manifest.monitors?.length) {
    return `${script.manifest.monitors.length} 个监听`;
  }
  return script.version ? `版本 ${script.version}` : '未提供脚本说明';
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

function upsertScript(scripts: JarvisScript[], script: JarvisScript) {
  return scripts.some((item) => item.id === script.id)
    ? scripts.map((item) => (item.id === script.id ? script : item))
    : [...scripts, script];
}

function patchSiteScript(siteId: string, script: JarvisScript) {
  const site = sites.value.find((item) => item.id === siteId);
  patchSiteScripts(siteId, upsertScript(site?.jarvisScripts ?? [], script));
}

function patchSiteScripts(siteId: string, scripts: JarvisScript[]) {
  sites.value = sites.value.map((site) => site.id === siteId ? { ...site, jarvisScripts: scripts } : site);
}


</script>

<template>
  <main class="script-page">
    <section class="script-page__body">
      <aside class="script-sidebar" aria-label="jarvis-script 分组">
        <div class="script-sidebar__heading">jarvis-script</div>
        <button
          type="button"
          :class="{ 'script-sidebar__item--active': selectedScope === 'global' }"
          class="script-sidebar__item"
          @click="selectGlobal"
        >
          <span class="script-sidebar__icon">
            <Code theme="outline" size="14" />
          </span>
          <span class="script-sidebar__text">全局脚本</span>
        </button>

        <div class="script-sidebar__section">
          <span class="script-sidebar__label">站点脚本</span>
          <button
            v-for="site in sites"
            :key="site.id"
            type="button"
            :class="{ 'script-sidebar__item--active': selectedScope === 'site' && selectedSiteId === site.id }"
            class="script-sidebar__item"
            @click="selectSite(site.id)"
          >
            <span class="script-sidebar__icon script-sidebar__icon--site">
              {{ siteInitial(site) }}
            </span>
            <span class="script-sidebar__text">{{ siteTitle(site) }}</span>
          </button>
          <p v-if="!sites.length" class="script-empty script-empty--compact">暂无站点</p>
        </div>
      </aside>

      <section class="script-panel">
        <header class="script-panel__head">
          <div class="script-panel__titles">
            <h1>jarvis-script</h1>
            <p>{{ pageTitle }} · {{ pageHint }}</p>
          </div>
          <ElButton :loading="loading" @click="loadPage">刷新</ElButton>
        </header>

        <div class="script-toolbar">
          <ElButton v-if="selectedScope === 'global'" type="primary" @click="installGlobalScript">
            <Code theme="outline" size="16" />
            安装全局脚本
          </ElButton>
          <ElButton v-else type="primary" :disabled="!selectedSiteId" @click="installSiteScript">
            <Code theme="outline" size="16" />
            安装到所选站点
          </ElButton>
        </div>

        <div class="script-summary" aria-label="jarvis-script 统计">
          <span class="script-summary__item">
            总计
            <strong>{{ installedCount }}</strong>
            个脚本
          </span>
          <span class="script-summary__item">
            当前分组启用
            <strong>{{ enabledCount }}</strong>
            个
          </span>
          <span class="script-summary__item">
            运行中
            <strong>{{ runningCount }}</strong>
            个
          </span>
        </div>

        <div class="script-list">
          <article
            v-for="script in activeScripts"
            :key="script.id"
            class="script-card"
            :class="{ 'script-card--error': scriptError(script) }"
          >
            <div class="script-card__icon">
              <Code theme="outline" size="18" />
            </div>
            <div class="script-card__main">
              <strong>{{ script.name }}</strong>
              <span>{{ scriptDetail(script) }}</span>
              <p v-if="scriptError(script)" class="script-card__error">最近错误：{{ scriptError(script) }}</p>
              <p v-else class="script-card__meta">
                <span class="script-card__status">
                  <Play theme="outline" size="12" />
                  {{ scriptStatus(script) }}
                </span>
                <small>{{ selectedScope === 'global' ? '全局' : '站点' }}</small>
                <small v-if="script.version">v{{ script.version }}</small>
                <small v-if="script.manifest.monitors?.length">{{ script.manifest.monitors.length }} 个监听</small>
              </p>
            </div>
            <div class="script-card__actions">
              <ElSwitch :model-value="script.runtimeState.enabled" @change="toggleScript(script)" />
              <button class="script-card__delete" type="button" title="卸载" @click="uninstallScript(script)">
                <Delete theme="outline" size="16" />
              </button>
            </div>
          </article>

          <p v-if="!activeScripts.length" class="script-empty">
            {{ selectedScope === 'global' ? '暂无全局 jarvis-script' : '所选站点暂无 jarvis-script' }}
          </p>
        </div>
      </section>
    </section>
  </main>
</template>

<style scoped>
.script-page {
  height: 100%;
  overflow: auto;
  background: linear-gradient(180deg, #f8fafc 0%, #eef3f8 100%);
}

.script-page__body {
  display: grid;
  width: min(1120px, 100%);
  min-height: 100%;
  grid-template-columns: 200px minmax(0, 1fr);
  gap: 28px;
  margin: 0 auto;
  padding: 32px 36px 44px;
  box-sizing: border-box;
}

.script-sidebar {
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

.script-sidebar__heading {
  padding: 0 8px 6px;
  color: #80868b;
  font-size: 11px;
  font-weight: 500;
}

.script-sidebar__section {
  display: grid;
  gap: 2px;
  margin-top: 6px;
  padding-top: 8px;
  border-top: 1px solid #edf0f2;
}

.script-sidebar__label {
  padding: 0 8px 4px;
  color: #80868b;
  font-size: 11px;
  font-weight: 500;
}

.script-sidebar__item {
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

.script-sidebar__item:hover {
  background: rgba(32, 33, 36, 0.05);
  color: #3c4043;
}

.script-sidebar__item--active,
.script-sidebar__item--active:hover {
  background: #e8f0fe;
  color: #174ea6;
  font-weight: 500;
}

.script-sidebar__icon {
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

.script-sidebar__icon--site {
  background: #f1f3f4;
  color: #80868b;
}

.script-sidebar__item--active .script-sidebar__icon {
  background: rgba(23, 78, 166, 0.1);
  color: #174ea6;
}

.script-sidebar__text {
  min-width: 0;
  overflow: hidden;
  font-size: 12px;
  font-weight: inherit;
  line-height: 1.2;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.script-panel {
  display: grid;
  align-content: start;
  gap: 16px;
  min-width: 0;
}

.script-panel__head {
  display: flex;
  min-height: 40px;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}

.script-panel__titles {
  display: grid;
  min-width: 0;
  gap: 4px;
}

.script-panel__titles h1 {
  margin: 0;
  color: #202124;
  font-size: 24px;
  font-weight: 650;
  line-height: 1.2;
}

.script-panel__titles p {
  margin: 0;
  overflow: hidden;
  color: #5f6368;
  font-size: 13px;
  line-height: 1.4;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.script-toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px;
}

.script-toolbar :deep(.el-button) {
  border-radius: 8px;
}

.script-toolbar :deep(.el-button > span) {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.script-summary {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
}

.script-summary__item {
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

.script-summary__item strong {
  color: #174ea6;
  font-size: 13px;
  font-weight: 650;
}

.script-list {
  display: grid;
  gap: 10px;
}

.script-card {
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

.script-card:hover {
  border-color: #d4dce7;
  box-shadow: 0 4px 14px rgba(15, 23, 42, 0.06);
}

.script-card--error {
  border-color: #f4c7c3;
  background: #fff8f7;
}

.script-card__icon {
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

.script-card__main {
  display: grid;
  min-width: 0;
  gap: 4px;
}

.script-card__main strong,
.script-card__main > span,
.script-card__meta {
  overflow: hidden;
  margin: 0;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.script-card__main strong {
  color: #202124;
  font-size: 14px;
  font-weight: 600;
  line-height: 1.3;
}

.script-card__main > span {
  color: #5f6368;
  font-size: 12px;
  line-height: 1.4;
}

.script-card__meta {
  display: flex;
  align-items: center;
  gap: 8px;
  color: #5f6368;
  font-size: 12px;
}

.script-card__status {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

.script-card__meta small {
  border-radius: 999px;
  padding: 1px 8px;
  background: #e8f0fe;
  color: #174ea6;
  font-size: 11px;
  font-weight: 500;
  line-height: 1.4;
}

.script-card__error {
  margin: 0;
  overflow: hidden;
  color: #c5221f;
  font-size: 12px;
  line-height: 1.4;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.script-card__actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.script-card__delete {
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

.script-card__delete:hover {
  background: #fce8e6;
  color: #d93025;
}

.script-empty {
  margin: 0;
  border: 1px dashed #d7dee8;
  border-radius: 8px;
  padding: 28px 18px;
  background: rgba(255, 255, 255, 0.72);
  color: #5f6368;
  font-size: 13px;
  text-align: center;
}

.script-empty--compact {
  padding: 12px 10px;
  font-size: 12px;
}

.script-panel__head :deep(.el-button) {
  border-radius: 8px;
}

@media (max-width: 1120px) {
  .script-page__body {
    width: min(100%, 1120px);
    grid-template-columns: 180px minmax(0, 1fr);
    gap: 20px;
    padding: 26px 28px 38px;
  }

  .script-sidebar {
    top: 26px;
  }
}
</style>
