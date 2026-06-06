<script setup lang="ts">
import {
  Close,
  Delete,
  Download,
  FolderOpen,
  Pause,
  Play,
  PreviewOpen,
} from '@icon-park/vue-next';
import { ElButton, ElMessage, ElProgress } from 'element-plus';
import { computed, onMounted } from 'vue';
import type { DownloadState } from '../../shared/types';
import { useBrowserStore } from '../stores/browser';
import { formatError } from '../../shared/utils';

const browser = useBrowserStore();

const groupedDownloads = computed(() => browser.downloads);

onMounted(async () => {
  await browser.loadDownloads();
});

async function run(action: () => Promise<void>) {
  try {
    await action();
  } catch (error) {
    ElMessage.error(formatError(error));
  }
}

function progress(download: DownloadState) {
  if (!download.totalBytes) {
    return 0;
  }

  return Math.min(100, Math.round((download.receivedBytes / download.totalBytes) * 100));
}

function statusText(download: DownloadState) {
  if (download.state === 'completed') {
    return '已完成';
  }

  if (download.state === 'cancelled') {
    return '已取消';
  }

  if (download.state === 'interrupted') {
    return download.canResume ? '已中断，可继续' : '已中断';
  }

  return download.paused ? '已暂停' : '下载中';
}

function originText(download: DownloadState) {
  try {
    return new URL(download.url).hostname;
  } catch {
    return download.url || '未知来源';
  }
}

function sizeText(bytes: number) {
  if (!bytes) {
    return '未知大小';
  }

  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  return `${value.toFixed(unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

function dateText(timestamp: number) {
  return new Date(timestamp).toLocaleString();
}

function canOpen(download: DownloadState) {
  return download.state === 'completed' && Boolean(download.savePath);
}

function canControl(download: DownloadState) {
  return download.state === 'progressing';
}


</script>

<template>
  <main class="downloads-page">
    <section class="downloads-page__body">
      <div class="downloads-page__tools">
        <span>{{ groupedDownloads.length }} 条下载记录</span>
        <ElButton :disabled="!groupedDownloads.length" @click="run(browser.clearDownloads)">
          <Delete theme="outline" size="16" />
          清除全部
        </ElButton>
      </div>

      <p v-if="!groupedDownloads.length" class="downloads-empty">
        暂无下载内容
      </p>

      <article
        v-for="download in groupedDownloads"
        :key="download.id"
        class="download-row"
      >
        <span class="download-row__icon">
          <Download theme="outline" size="20" />
        </span>
        <div class="download-row__main">
          <div class="download-row__title">
            <strong>{{ download.filename }}</strong>
            <span>{{ statusText(download) }}</span>
          </div>
          <ElProgress
            v-if="download.state === 'progressing'"
            :percentage="progress(download)"
            :show-text="false"
          />
          <div class="download-row__meta">
            <span>{{ originText(download) }}</span>
            <span>{{ sizeText(download.receivedBytes) }} / {{ sizeText(download.totalBytes) }}</span>
            <span>{{ dateText(download.startTime) }}</span>
          </div>
        </div>
        <div class="download-row__actions">
          <button
            v-if="canControl(download) && !download.paused"
            type="button"
            title="暂停"
            @click="run(() => browser.pauseDownload(download))"
          >
            <Pause theme="outline" size="16" />
          </button>
          <button
            v-if="canControl(download) && download.paused"
            type="button"
            title="继续"
            @click="run(() => browser.resumeDownload(download))"
          >
            <Play theme="outline" size="16" />
          </button>
          <button
            v-if="canControl(download)"
            type="button"
            title="取消"
            @click="run(() => browser.cancelDownload(download))"
          >
            <Close theme="outline" size="16" />
          </button>
          <button
            type="button"
            title="打开文件"
            :disabled="!canOpen(download)"
            @click="run(() => browser.openDownload(download))"
          >
            <PreviewOpen theme="outline" size="16" />
          </button>
          <button
            type="button"
            title="在文件夹中显示"
            :disabled="!download.savePath"
            @click="run(() => browser.showDownloadInFolder(download))"
          >
            <FolderOpen theme="outline" size="16" />
          </button>
          <button
            type="button"
            title="移除记录"
            @click="run(() => browser.removeDownload(download))"
          >
            <Delete theme="outline" size="16" />
          </button>
        </div>
      </article>
    </section>
  </main>
</template>
