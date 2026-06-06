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
    <aside class="script-sidebar" aria-label="jarvis-script 分组">
      <button
        type="button"
        :class="{ 'script-sidebar__item--active': selectedScope === 'global' }"
        class="script-sidebar__item"
        @click="selectGlobal"
      >
        全局
      </button>
      <span class="script-sidebar__label">站点</span>
      <button
        v-for="site in sites"
        :key="site.id"
        type="button"
        :class="{ 'script-sidebar__item--active': selectedScope === 'site' && selectedSiteId === site.id }"
        class="script-sidebar__item"
        @click="selectSite(site.id)"
      >
        {{ siteTitle(site) }}
      </button>
      <p v-if="!sites.length" class="drawer-empty">暂无站点</p>
    </aside>

    <section class="script-panel">
      <header class="script-panel__head script-panel__head--page">
        <div>
          <strong>jarvis-script</strong>
          <span>{{ pageTitle }} · {{ pageHint }}</span>
        </div>
        <div class="script-panel__head-actions">
          <ElButton :loading="loading" @click="loadPage">刷新</ElButton>
          <ElButton v-if="selectedScope === 'global'" type="primary" @click="installGlobalScript">
            <Code theme="outline" size="16" />
            安装
          </ElButton>
          <ElButton v-else type="primary" :disabled="!selectedSiteId" @click="installSiteScript">
            <Code theme="outline" size="16" />
            安装
          </ElButton>
        </div>
      </header>

      <article v-for="script in activeScripts" :key="script.id" class="script-card">
        <div class="script-card__icon">
          <Code theme="outline" size="18" />
        </div>
        <div class="script-card__main">
          <strong>{{ script.name }}</strong>
          <span>{{ scriptDetail(script) }}</span>
          <p class="script-card__status">
            <Play theme="outline" size="13" />
            {{ scriptStatus(script) }}
          </p>
          <p v-if="scriptError(script)" class="script-card__error">最近错误：{{ scriptError(script) }}</p>
        </div>
        <div class="script-card__actions">
          <ElSwitch :model-value="script.runtimeState.enabled" @change="toggleScript(script)" />
          <button type="button" title="卸载" @click="uninstallScript(script)">
            <Delete theme="outline" size="16" />
          </button>
        </div>
      </article>

      <p v-if="!activeScripts.length" class="drawer-empty">
        {{ selectedScope === 'global' ? '暂无全局 jarvis-script' : '所选站点暂无 jarvis-script' }}
      </p>
    </section>
  </main>
</template>

<style scoped>
.script-page {
  display: grid;
  height: 100%;
  grid-template-columns: 240px minmax(0, 1fr);
  gap: 24px;
  overflow: hidden;
  padding: 28px;
  background: #f8fafc;
}

.script-sidebar,
.script-panel {
  min-height: 0;
  overflow: auto;
}

.script-sidebar {
  display: grid;
  align-content: start;
  gap: 6px;
  border-right: 1px solid #e4e7eb;
  padding-right: 16px;
}

.script-sidebar__label {
  margin-top: 12px;
  padding: 0 10px;
  color: #5f6368;
  font-size: 12px;
}

.script-sidebar__item {
  min-height: 34px;
  border: 0;
  border-radius: 6px;
  padding: 0 10px;
  background: transparent;
  color: #3c4043;
  text-align: left;
}

.script-sidebar__item:hover,
.script-sidebar__item--active {
  background: #e8f0fe;
  color: #174ea6;
}

.script-panel {
  display: grid;
  align-content: start;
  gap: 12px;
}

.script-panel__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  border-bottom: 1px solid #edf0f2;
  padding-bottom: 10px;
}

.script-panel__head div {
  display: grid;
  min-width: 0;
  gap: 4px;
}

.script-panel__head strong {
  color: #202124;
  font-size: 15px;
}

.script-panel__head span {
  overflow: hidden;
  color: #5f6368;
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.script-panel__head-actions {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}

.script-card {
  display: grid;
  min-width: 0;
  grid-template-columns: 42px minmax(0, 1fr) auto;
  align-items: center;
  gap: 12px;
  border: 1px solid #dadce0;
  border-radius: 8px;
  padding: 12px;
  background: #ffffff;
}

.script-card__icon {
  display: inline-flex;
  width: 36px;
  height: 36px;
  align-items: center;
  justify-content: center;
  border-radius: 8px;
  background: #f1f3f4;
  color: #3c4043;
}

.script-card__main {
  display: grid;
  min-width: 0;
  gap: 3px;
}

.script-card__main strong,
.script-card__main span,
.script-card__main p {
  overflow: hidden;
  margin: 0;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.script-card__main strong {
  color: #202124;
  font-size: 14px;
}

.script-card__main span,
.script-card__main p {
  color: #5f6368;
  font-size: 12px;
}

.script-card__status {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

.script-card__error {
  color: #c5221f;
}

.script-card__actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.script-card__actions button {
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

.script-card__actions button:hover {
  background: #f1f3f4;
  color: #d93025;
}
</style>
