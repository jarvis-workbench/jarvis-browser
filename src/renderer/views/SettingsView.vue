<script setup lang="ts">
import { Code, Copy, Download, FolderOpen, History, Plug, Refresh, SettingWeb, VacuumCleaner } from '@icon-park/vue-next';
import { ElButton, ElInput, ElInputNumber, ElMessage, ElProgress, ElSwitch } from 'element-plus';
import { computed, onMounted, ref } from 'vue';
import type { BrowserInternalPageId } from '../../shared/types';
import { formatError } from '../../shared/utils';
import { useBrowserStore } from '../stores/browser';

const browser = useBrowserStore();

const settings = computed(() => browser.downloadSettings);
const automationBridge = computed(() => browser.automationBridgeStatus);
const updateStatus = computed(() => browser.appUpdateStatus);
const updateProgress = computed(() => Math.round(updateStatus.value.progress?.percent || 0));
const isCheckingForUpdates = ref(false);
const isDownloadingUpdate = ref(false);
const isInstallingUpdate = ref(false);
const isUpdatingAutomationBridge = ref(false);
const isRegeneratingAutomationToken = ref(false);
const pendingAutomationPort = ref(17361);
const canCheckForUpdates = computed(() => ![
  'unsupported',
  'checking',
  'downloading',
  'installing',
].includes(updateStatus.value.phase));
const checkUpdateLabel = computed(() => (
  updateStatus.value.phase === 'unsupported'
    ? '无法检查'
    : ['idle'].includes(updateStatus.value.phase)
      ? '检查更新'
      : '重新检查'
));
const canDownloadUpdate = computed(() => updateStatus.value.phase === 'available');
const automationBridgeStatusText = computed(() => {
  if (!automationBridge.value?.enabled) {
    return '未开启';
  }
  if (automationBridge.value.running) {
    return '运行中';
  }
  return automationBridge.value.lastError || '启动失败';
});
const navItems: Array<{ pageId: BrowserInternalPageId; label: string; icon: typeof Download }> = [
  { pageId: 'settings', label: '下载内容', icon: Download },
  { pageId: 'downloads', label: '下载记录', icon: Download },
  { pageId: 'history', label: '历史记录', icon: History },
  { pageId: 'clear-browsing-data', label: '删除浏览数据', icon: VacuumCleaner },
  { pageId: 'extensions', label: '扩展程序管理', icon: Plug },
  { pageId: 'jarvis-script', label: 'jarvis-script', icon: Code },
];

onMounted(async () => {
  await Promise.all([
    browser.loadSettings(),
    browser.loadUpdateStatus(),
  ]);
  pendingAutomationPort.value = automationBridge.value?.port || 17361;
});

async function selectDownloadPath() {
  try {
    await browser.selectDownloadPath();
  } catch (error) {
    ElMessage.error(formatError(error));
  }
}

async function openInternalPage(pageId: BrowserInternalPageId) {
  try {
    await browser.activateInternalPage(pageId);
  } catch (error) {
    ElMessage.error(formatError(error));
  }
}

async function updateAskBeforeDownload(value: string | number | boolean) {
  try {
    await browser.updateDownloadSettings({
      askWhereToSaveBeforeDownloading: Boolean(value),
    });
  } catch (error) {
    ElMessage.error(formatError(error));
  }
}

async function updateAutomationEnabled(value: string | number | boolean) {
  try {
    isUpdatingAutomationBridge.value = true;
    await browser.updateAutomationBridge({
      enabled: Boolean(value),
      port: pendingAutomationPort.value,
    });
    pendingAutomationPort.value = automationBridge.value?.port || pendingAutomationPort.value;
  } catch (error) {
    ElMessage.error(formatError(error));
  } finally {
    isUpdatingAutomationBridge.value = false;
  }
}

async function updateAutomationPort() {
  try {
    isUpdatingAutomationBridge.value = true;
    await browser.updateAutomationBridge({
      port: pendingAutomationPort.value,
      enabled: automationBridge.value?.enabled || false,
    });
    pendingAutomationPort.value = automationBridge.value?.port || pendingAutomationPort.value;
  } catch (error) {
    ElMessage.error(formatError(error));
  } finally {
    isUpdatingAutomationBridge.value = false;
  }
}

async function regenerateAutomationToken() {
  try {
    isRegeneratingAutomationToken.value = true;
    await browser.regenerateAutomationBridgeToken();
  } catch (error) {
    ElMessage.error(formatError(error));
  } finally {
    isRegeneratingAutomationToken.value = false;
  }
}

async function copyAutomationText(value?: string) {
  if (!value) {
    return;
  }

  try {
    await navigator.clipboard.writeText(value);
    ElMessage.success('已复制');
  } catch (error) {
    ElMessage.error(formatError(error));
  }
}

async function checkForUpdates() {
  if (!canCheckForUpdates.value) {
    if (updateStatus.value.phase === 'unsupported') {
      ElMessage.info(updateStatus.value.errorText || unsupportedUpdateText());
    }
    return;
  }

  try {
    isCheckingForUpdates.value = true;
    await browser.checkForUpdates();
  } catch (error) {
    ElMessage.error(formatError(error));
  } finally {
    isCheckingForUpdates.value = false;
  }
}

async function downloadUpdate() {
  if (!canDownloadUpdate.value) {
    ElMessage.info(updateStatus.value.errorText || '暂无可下载的更新');
    return;
  }

  try {
    isDownloadingUpdate.value = true;
    await browser.downloadUpdate();
  } catch (error) {
    ElMessage.error(formatError(error));
  } finally {
    isDownloadingUpdate.value = false;
  }
}

async function quitAndInstallUpdate() {
  try {
    isInstallingUpdate.value = true;
    await browser.quitAndInstallUpdate();
  } catch (error) {
    ElMessage.error(formatError(error));
    isInstallingUpdate.value = false;
  }
}

function updatePhaseText() {
  return {
    idle: '尚未检查更新',
    unsupported: updateStatus.value.errorText || '当前环境不支持自动更新',
    checking: '正在检查更新',
    available: '发现新版本，点击更新后开始下载',
    'not-available': '当前已是最新版本',
    downloading: '正在下载更新',
    downloaded: '更新已下载，点击重启安装后完成安装',
    installing: '正在重启安装',
    error: '更新检查失败',
  }[updateStatus.value.phase];
}

function releaseDateText(value?: string) {
  if (!value) {
    return '';
  }

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function unsupportedUpdateText() {
  return updateStatus.value.isPackaged
    ? updateStatus.value.errorText || '当前平台暂不支持自动更新'
    : 'development mode cannot perform real updates.';
}
</script>

<template>
  <main class="settings-page">
    <section class="settings-page__body">
      <aside class="settings-nav">
        <button
          v-for="item in navItems"
          :key="item.pageId"
          class="settings-nav__item"
          :class="{ 'settings-nav__item--active': item.pageId === 'settings' }"
          type="button"
          @click="openInternalPage(item.pageId)"
        >
          <component :is="item.icon" theme="outline" size="18" />
          <span>{{ item.label }}</span>
        </button>
      </aside>

      <section class="settings-content" aria-label="下载设置">
        <h1>下载内容</h1>

        <div class="settings-row">
          <div class="settings-row__text">
            <strong>位置</strong>
            <span>文件默认保存到此文件夹。</span>
          </div>
          <div class="settings-row__control settings-row__control--path">
            <ElInput :model-value="settings?.downloadPath || ''" readonly />
            <ElButton @click="selectDownloadPath">
              <FolderOpen theme="outline" size="16" />
              更改
            </ElButton>
          </div>
        </div>

        <div class="settings-row">
          <div class="settings-row__text">
            <strong>下载前询问每个文件的保存位置</strong>
            <span>开启后，每次下载都会先显示保存位置选择。</span>
          </div>
          <ElSwitch
            :model-value="settings?.askWhereToSaveBeforeDownloading || false"
            @update:model-value="updateAskBeforeDownload"
          />
        </div>

        <section class="settings-section" aria-label="本机自动化桥">
          <h2>本机自动化桥</h2>

          <div class="settings-row">
            <div class="settings-row__text">
              <strong>启用</strong>
              <span>{{ automationBridgeStatusText }}</span>
            </div>
            <ElSwitch
              :model-value="automationBridge?.enabled || false"
              :disabled="isUpdatingAutomationBridge"
              @update:model-value="updateAutomationEnabled"
            />
          </div>

          <div class="settings-row">
            <div class="settings-row__text">
              <strong>端口</strong>
              <span>{{ automationBridge?.origin || `http://127.0.0.1:${pendingAutomationPort}` }}</span>
            </div>
            <div class="settings-row__control settings-row__control--port">
              <ElInputNumber
                v-model="pendingAutomationPort"
                :min="1024"
                :max="65535"
                :step="1"
                controls-position="right"
                :disabled="isUpdatingAutomationBridge"
              />
              <ElButton :loading="isUpdatingAutomationBridge" @click="updateAutomationPort">
                <SettingWeb theme="outline" size="16" />
                应用
              </ElButton>
            </div>
          </div>

          <div class="settings-row settings-row--top">
            <div class="settings-row__text">
              <strong>地址</strong>
              <span class="settings-row__mono">{{ automationBridge?.origin || '' }}</span>
            </div>
            <ElButton :disabled="!automationBridge?.origin" @click="copyAutomationText(automationBridge?.origin)">
              <Copy theme="outline" size="16" />
              复制
            </ElButton>
          </div>

          <div class="settings-row settings-row--top">
            <div class="settings-row__text">
              <strong>Token</strong>
              <span class="settings-row__mono">{{ automationBridge?.token || '' }}</span>
            </div>
            <div class="settings-row__control settings-row__control--actions">
              <ElButton :disabled="!automationBridge?.token" @click="copyAutomationText(automationBridge?.token)">
                <Copy theme="outline" size="16" />
                复制
              </ElButton>
              <ElButton :loading="isRegeneratingAutomationToken" @click="regenerateAutomationToken">
                <Refresh theme="outline" size="16" />
                重置
              </ElButton>
            </div>
          </div>
        </section>

        <section class="settings-section" aria-label="更新">
          <h2>更新</h2>

          <div class="settings-row settings-row--top">
            <div class="settings-row__text">
              <strong>Jarvis Browser {{ updateStatus.currentVersion || '未知版本' }}</strong>
              <span>{{ updatePhaseText() }}</span>
            </div>
            <div class="settings-row__control settings-row__control--actions">
              <ElButton
                v-if="!['available', 'downloading', 'downloaded'].includes(updateStatus.phase)"
                :disabled="!canCheckForUpdates || isCheckingForUpdates"
                :loading="isCheckingForUpdates"
                @click="checkForUpdates"
              >
                <Download theme="outline" size="16" />
                {{ checkUpdateLabel }}
              </ElButton>
              <ElButton
                v-if="updateStatus.phase === 'available'"
                type="primary"
                :disabled="!canDownloadUpdate || isDownloadingUpdate"
                :loading="isDownloadingUpdate"
                @click="downloadUpdate"
              >
                <Download theme="outline" size="16" />
                更新
              </ElButton>
              <ElButton
                v-if="updateStatus.phase === 'downloading'"
                type="primary"
                disabled
              >
                <Download theme="outline" size="16" />
                下载中 {{ updateProgress }}%
              </ElButton>
              <ElButton
                v-if="updateStatus.phase === 'downloaded'"
                type="primary"
                :disabled="isInstallingUpdate"
                :loading="isInstallingUpdate"
                @click="quitAndInstallUpdate"
              >
                <Download theme="outline" size="16" />
                重启安装
              </ElButton>
            </div>
          </div>

          <div
            v-if="updateStatus.phase === 'downloading' || updateStatus.phase === 'downloaded'"
            class="update-panel"
          >
            <ElProgress :percentage="updateProgress" />
          </div>

          <div
            v-if="updateStatus.availableVersion || updateStatus.releaseName || updateStatus.releaseDate || updateStatus.releaseNotes"
            class="update-panel update-panel--release"
          >
            <dl class="update-details">
              <template v-if="updateStatus.availableVersion">
                <dt>可用版本</dt>
                <dd>{{ updateStatus.availableVersion }}</dd>
              </template>
              <template v-if="updateStatus.releaseName">
                <dt>发布名称</dt>
                <dd>{{ updateStatus.releaseName }}</dd>
              </template>
              <template v-if="updateStatus.releaseDate">
                <dt>发布时间</dt>
                <dd>{{ releaseDateText(updateStatus.releaseDate) }}</dd>
              </template>
              <template v-if="updateStatus.releaseNotes">
                <dt>更新说明</dt>
                <dd class="update-details__notes">{{ updateStatus.releaseNotes }}</dd>
              </template>
            </dl>
          </div>

          <p v-if="updateStatus.phase === 'unsupported'" class="update-message">
            {{ unsupportedUpdateText() }}
          </p>
          <p v-if="updateStatus.phase === 'error'" class="update-message update-message--error">
            {{ updateStatus.errorText || '未知错误' }}
          </p>
        </section>
      </section>
    </section>
  </main>
</template>

<style scoped>
.settings-section {
  display: grid;
  gap: 12px;
  padding-top: 18px;
}

.settings-section h2 {
  margin: 0;
  color: #202124;
  font-size: 18px;
  font-weight: 600;
}

.settings-row--top {
  align-items: start;
}

.settings-row__control--actions {
  display: inline-flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 8px;
}

.settings-row__control--actions :deep(.el-button) {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.settings-row__control--port {
  display: inline-flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
}

.settings-row__control--port :deep(.el-input-number) {
  width: 132px;
}

.settings-row__control--port :deep(.el-button),
.settings-row--top > :deep(.el-button) {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.settings-row__mono {
  max-width: min(520px, 48vw);
  overflow-wrap: anywhere;
  color: #3c4043;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
}

.update-panel {
  border-bottom: 1px solid #edf0f2;
  padding: 0 0 16px;
}

.update-panel--release {
  padding-top: 4px;
}

.update-details {
  display: grid;
  grid-template-columns: 88px minmax(0, 1fr);
  gap: 8px 14px;
  margin: 0;
  color: #3c4043;
  font-size: 13px;
}

.update-details dt {
  color: #5f6368;
}

.update-details dd {
  min-width: 0;
  margin: 0;
  overflow-wrap: anywhere;
}

.update-details__notes {
  white-space: pre-wrap;
}

.update-message {
  margin: 0;
  color: #5f6368;
  font-size: 12px;
}

.update-message--error {
  color: #c5221f;
}
</style>
