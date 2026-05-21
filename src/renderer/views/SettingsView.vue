<script setup lang="ts">
import { Code, Download, FolderOpen, History, Plug, VacuumCleaner } from '@icon-park/vue-next';
import { ElButton, ElInput, ElMessage, ElProgress, ElSwitch } from 'element-plus';
import { computed, onMounted } from 'vue';
import type { BrowserInternalPageId } from '../../shared/types';
import { useBrowserStore } from '../stores/browser';

const browser = useBrowserStore();

const settings = computed(() => browser.downloadSettings);
const updateStatus = computed(() => browser.appUpdateStatus);
const updateProgress = computed(() => Math.round(updateStatus.value.progress?.percent || 0));
const canCheckForUpdates = computed(() => !['checking', 'downloading', 'installing'].includes(updateStatus.value.phase));
const checkUpdateLabel = computed(() => (
  ['idle', 'unsupported'].includes(updateStatus.value.phase) ? '检查更新' : '重新检查'
));
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

async function checkForUpdates() {
  try {
    await browser.checkForUpdates();
  } catch (error) {
    ElMessage.error(formatError(error));
  }
}

async function quitAndInstallUpdate() {
  try {
    await browser.quitAndInstallUpdate();
  } catch (error) {
    ElMessage.error(formatError(error));
  }
}

function updatePhaseText() {
  return {
    idle: '尚未检查更新',
    unsupported: updateStatus.value.errorText || '当前环境不支持自动更新',
    checking: '正在检查更新',
    available: '发现新版本，正在自动下载',
    'not-available': '当前已是最新版本',
    downloading: '正在下载更新',
    downloaded: '更新已下载，重启后安装',
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

function formatError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
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

        <section class="settings-section" aria-label="更新">
          <h2>更新</h2>

          <div class="settings-row settings-row--top">
            <div class="settings-row__text">
              <strong>Jarvis Browser {{ updateStatus.currentVersion || '未知版本' }}</strong>
              <span>{{ updatePhaseText() }}</span>
            </div>
            <div class="settings-row__control settings-row__control--actions">
              <ElButton :disabled="!canCheckForUpdates" @click="checkForUpdates">
                <Download theme="outline" size="16" />
                {{ checkUpdateLabel }}
              </ElButton>
              <ElButton
                v-if="updateStatus.phase === 'downloaded'"
                type="primary"
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
