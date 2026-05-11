<script setup lang="ts">
import { Code, Download, FolderOpen, History, Plug, VacuumCleaner } from '@icon-park/vue-next';
import { ElButton, ElInput, ElMessage, ElSwitch } from 'element-plus';
import { computed, onMounted } from 'vue';
import type { BrowserInternalPageId } from '../../shared/types';
import { useBrowserStore } from '../stores/browser';

const browser = useBrowserStore();

const settings = computed(() => browser.downloadSettings);
const navItems: Array<{ pageId: BrowserInternalPageId; label: string; icon: typeof Download }> = [
  { pageId: 'settings', label: '下载内容', icon: Download },
  { pageId: 'downloads', label: '下载记录', icon: Download },
  { pageId: 'history', label: '历史记录', icon: History },
  { pageId: 'clear-browsing-data', label: '删除浏览数据', icon: VacuumCleaner },
  { pageId: 'extensions', label: '扩展程序管理', icon: Plug },
  { pageId: 'jarvis-script', label: 'jarvis-script', icon: Code },
];

onMounted(async () => {
  await browser.loadSettings();
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
      </section>
    </section>
  </main>
</template>
