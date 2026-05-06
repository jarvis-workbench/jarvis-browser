<script setup lang="ts">
import { Download, FolderOpen } from '@icon-park/vue-next';
import { ElButton, ElInput, ElMessage, ElSwitch } from 'element-plus';
import { computed, onMounted } from 'vue';
import { useBrowserStore } from '../stores/browser';

const browser = useBrowserStore();

const settings = computed(() => browser.downloadSettings);

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
        <button class="settings-nav__item settings-nav__item--active" type="button">
          <Download theme="outline" size="18" />
          <span>下载内容</span>
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
