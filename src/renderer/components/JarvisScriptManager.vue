<script setup lang="ts">
import { Code, Delete, Play } from '@icon-park/vue-next';
import { ElButton, ElMessage, ElMessageBox, ElSwitch } from 'element-plus';
import { computed } from 'vue';
import type { JarvisScript } from '../../shared/types';
import { useBrowserStore } from '../stores/browser';
import BrowserDrawer from './BrowserDrawer.vue';

defineProps<{
  modelValue: boolean;
}>();

const emit = defineEmits<{
  'update:modelValue': [value: boolean];
}>();

const browser = useBrowserStore();
const currentSiteTitle = computed(() => (
  browser.selectedSite ? browser.siteDisplayTitle(browser.selectedSite) : '当前站点'
));

async function installGlobalScript() {
  try {
    await browser.installGlobalScript();
  } catch (error) {
    ElMessage.error(formatError(error));
  }
}

async function installSiteScript() {
  try {
    await browser.installSiteScript();
  } catch (error) {
    ElMessage.error(formatError(error));
  }
}

async function toggleGlobalScript(script: JarvisScript) {
  try {
    await browser.toggleGlobalScript(script);
  } catch (error) {
    ElMessage.error(formatError(error));
  }
}

async function toggleSiteScript(script: JarvisScript) {
  try {
    await browser.toggleSiteScript(script);
  } catch (error) {
    ElMessage.error(formatError(error));
  }
}

async function uninstallGlobalScript(script: JarvisScript) {
  try {
    await ElMessageBox.confirm(`确认卸载全局脚本「${script.name}」吗？`, '卸载 Jarvis 脚本', {
      confirmButtonText: '确认卸载',
      cancelButtonText: '取消',
      type: 'warning',
    });
    await browser.uninstallGlobalScript(script);
  } catch (error) {
    if (error !== 'cancel') {
      ElMessage.error(formatError(error));
    }
  }
}

async function uninstallSiteScript(script: JarvisScript) {
  try {
    await ElMessageBox.confirm(`确认卸载当前站点脚本「${script.name}」吗？`, '卸载 Jarvis 脚本', {
      confirmButtonText: '确认卸载',
      cancelButtonText: '取消',
      type: 'warning',
    });
    await browser.uninstallSiteScript(script);
  } catch (error) {
    if (error !== 'cancel') {
      ElMessage.error(formatError(error));
    }
  }
}

function scriptStatus(script: JarvisScript) {
  if (!script.runtimeState.enabled) {
    return '已停用';
  }

  if (script.runtimeState.loadError) {
    return '异常';
  }

  if (isRunning(script)) {
    return '运行中';
  }

  return '已启用';
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

function formatError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
</script>

<template>
  <BrowserDrawer
    :model-value="modelValue"
    title="Jarvis 脚本"
    width="420px"
    @update:model-value="emit('update:modelValue', $event)"
  >
    <div class="script-panel">
      <section class="script-panel__section">
        <header class="script-panel__head">
          <div>
            <strong>全局脚本</strong>
            <span>打开任意站点会话时可用</span>
          </div>
          <ElButton size="small" type="primary" @click="installGlobalScript">
            <Code theme="outline" size="16" />
            安装
          </ElButton>
        </header>

        <article v-for="script in browser.globalScripts" :key="script.id" class="script-card">
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
            <ElSwitch :model-value="script.runtimeState.enabled" @change="toggleGlobalScript(script)" />
            <button type="button" title="卸载" @click="uninstallGlobalScript(script)">
              <Delete theme="outline" size="16" />
            </button>
          </div>
        </article>

        <p v-if="browser.globalScripts.length === 0" class="drawer-empty">暂无全局脚本</p>
      </section>

      <section class="script-panel__section">
        <header class="script-panel__head">
          <div>
            <strong>当前站点脚本</strong>
            <span>只在 {{ currentSiteTitle }} 的会话中可用</span>
          </div>
          <ElButton size="small" type="primary" @click="installSiteScript">
            <Code theme="outline" size="16" />
            安装
          </ElButton>
        </header>

        <article v-for="script in browser.siteScripts" :key="script.id" class="script-card">
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
            <ElSwitch :model-value="script.runtimeState.enabled" @change="toggleSiteScript(script)" />
            <button type="button" title="卸载" @click="uninstallSiteScript(script)">
              <Delete theme="outline" size="16" />
            </button>
          </div>
        </article>

        <p v-if="browser.siteScripts.length === 0" class="drawer-empty">当前站点未安装脚本</p>
      </section>
    </div>
  </BrowserDrawer>
</template>

<style scoped>
.script-panel {
  display: grid;
  gap: 22px;
}

.script-panel__section {
  display: grid;
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
