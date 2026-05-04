<script setup lang="ts">
import { Delete, Plug } from '@icon-park/vue-next';
import { ElButton, ElMessage, ElSwitch } from 'element-plus';
import type { SiteExtension } from '../../shared/types';
import { useBrowserStore } from '../stores/browser';
import BrowserDrawer from './BrowserDrawer.vue';

defineProps<{
  modelValue: boolean;
}>();

const emit = defineEmits<{
  'update:modelValue': [value: boolean];
}>();

const browser = useBrowserStore();

async function installGlobalExtension() {
  try {
    await browser.installGlobalExtension();
  } catch (error) {
    ElMessage.error(formatError(error));
  }
}

async function installSiteExtension() {
  try {
    await browser.installSiteExtension();
  } catch (error) {
    ElMessage.error(formatError(error));
  }
}

async function toggleGlobalExtension(extension: SiteExtension) {
  try {
    await browser.toggleGlobalExtension(extension);
  } catch (error) {
    ElMessage.error(formatError(error));
  }
}

async function toggleSiteExtension(extension: SiteExtension) {
  try {
    await browser.toggleSiteExtension(extension);
  } catch (error) {
    ElMessage.error(formatError(error));
  }
}

async function uninstallGlobalExtension(extension: SiteExtension) {
  try {
    await browser.uninstallGlobalExtension(extension);
  } catch (error) {
    ElMessage.error(formatError(error));
  }
}

async function uninstallSiteExtension(extension: SiteExtension) {
  try {
    await browser.uninstallSiteExtension(extension);
  } catch (error) {
    ElMessage.error(formatError(error));
  }
}

function formatError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
</script>

<template>
  <BrowserDrawer
    :model-value="modelValue"
    title="插件管理"
    width="420px"
    @update:model-value="emit('update:modelValue', $event)"
  >
    <div class="extension-panel">
      <section class="extension-panel__section">
        <header class="extension-panel__head">
          <div>
            <strong>全局插件</strong>
            <span>打开任意站点会话时加载</span>
          </div>
          <ElButton size="small" type="primary" @click="installGlobalExtension">
            <Plug theme="outline" size="16" />
            安装
          </ElButton>
        </header>

        <article v-for="extension in browser.globalExtensions" :key="extension.id" class="extension-card">
          <div class="extension-card__icon">
            <img v-if="extension.icon" :src="extension.icon" alt="" />
            <Plug v-else theme="outline" size="18" />
          </div>
          <div class="extension-card__main">
            <strong>{{ extension.name }}</strong>
            <span>版本 {{ extension.version }}</span>
            <p v-if="extension.loadError">{{ extension.loadError }}</p>
            <p v-else>{{ extension.permissions.length }} 项权限</p>
          </div>
          <div class="extension-card__actions">
            <ElSwitch :model-value="extension.enabled" @change="toggleGlobalExtension(extension)" />
            <button type="button" title="卸载" @click="uninstallGlobalExtension(extension)">
              <Delete theme="outline" size="16" />
            </button>
          </div>
        </article>

        <p v-if="browser.globalExtensions.length === 0" class="drawer-empty">暂无全局插件</p>
      </section>

      <section class="extension-panel__section">
        <header class="extension-panel__head">
          <div>
            <strong>当前站点插件</strong>
            <span>只在当前站点会话中加载</span>
          </div>
          <ElButton size="small" type="primary" @click="installSiteExtension">
            <Plug theme="outline" size="16" />
            安装
          </ElButton>
        </header>

        <article v-for="extension in browser.siteExtensions" :key="extension.id" class="extension-card">
          <div class="extension-card__icon">
            <img v-if="extension.icon" :src="extension.icon" alt="" />
            <Plug v-else theme="outline" size="18" />
          </div>
          <div class="extension-card__main">
            <strong>{{ extension.name }}</strong>
            <span>版本 {{ extension.version }}</span>
            <p v-if="extension.loadError">{{ extension.loadError }}</p>
            <p v-else>{{ extension.permissions.length }} 项权限</p>
          </div>
          <div class="extension-card__actions">
            <ElSwitch :model-value="extension.enabled" @change="toggleSiteExtension(extension)" />
            <button type="button" title="卸载" @click="uninstallSiteExtension(extension)">
              <Delete theme="outline" size="16" />
            </button>
          </div>
        </article>

        <p v-if="browser.siteExtensions.length === 0" class="drawer-empty">当前站点未安装插件</p>
      </section>
    </div>
  </BrowserDrawer>
</template>
