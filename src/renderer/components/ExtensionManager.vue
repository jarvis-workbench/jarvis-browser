<script setup lang="ts">
import { Delete, FolderOpen, Plug, Search } from '@icon-park/vue-next';
import { ElButton, ElMessage, ElSwitch } from 'element-plus';
import { computed, ref } from 'vue';
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
const searchText = ref('');

const installedCount = computed(() => browser.globalExtensions.length + browser.siteExtensions.length);
const enabledCount = computed(() => allExtensions().filter((extension) => extension.enabled).length);
const selectedSiteTitle = computed(() => browser.selectedSite ? browser.siteDisplayTitle(browser.selectedSite) : '未选择站点');
const filteredGlobalExtensions = computed(() => filterExtensions(browser.globalExtensions));
const filteredSiteExtensions = computed(() => filterExtensions(browser.siteExtensions));

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

function filterExtensions(extensions: SiteExtension[]) {
  const keyword = searchText.value.trim().toLowerCase();
  if (!keyword) {
    return extensions;
  }

  return extensions.filter((extension) => {
    return extension.name.toLowerCase().includes(keyword)
      || extension.version.toLowerCase().includes(keyword)
      || extension.permissions.some((permission) => permission.toLowerCase().includes(keyword));
  });
}

function allExtensions() {
  return [...browser.globalExtensions, ...browser.siteExtensions];
}

function permissionText(extension: SiteExtension) {
  return extension.permissions.length ? `${extension.permissions.length} 项权限` : '无额外权限';
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
      <section class="extension-hero">
        <div class="extension-hero__copy">
          <strong>Chrome 扩展目录</strong>
          <span>仅支持已解压扩展目录，请选择包含 manifest.json 的文件夹。</span>
        </div>
        <span class="extension-hero__badge">目录模式</span>
      </section>

      <label class="extension-search">
        <Search theme="outline" size="18" />
        <input v-model="searchText" type="search" placeholder="搜索插件" />
      </label>

      <div class="extension-install-grid">
        <ElButton type="primary" @click="installGlobalExtension">
          <FolderOpen theme="outline" size="16" />
          安装全局插件
        </ElButton>
        <ElButton :disabled="!browser.selectedSite" @click="installSiteExtension">
          <FolderOpen theme="outline" size="16" />
          安装到当前站点
        </ElButton>
      </div>

      <div class="extension-drop-hint">
        <span class="extension-drop-hint__icon">
          <Plug theme="outline" size="22" />
        </span>
        <span>
          <strong>选择已解压扩展目录</strong>
          <small>请选择包含 manifest.json 的扩展文件夹。</small>
        </span>
      </div>

      <div class="extension-summary">
        <span>已安装 <strong>{{ installedCount }}</strong> 个插件</span>
        <span>启用 <strong>{{ enabledCount }}</strong> 个</span>
        <span>当前站点：{{ selectedSiteTitle }}</span>
      </div>

      <section class="extension-panel__section">
        <header class="extension-panel__head">
          <div>
            <strong>全局插件</strong>
            <span>打开任意站点会话时加载</span>
          </div>
        </header>

        <article
          v-for="extension in filteredGlobalExtensions"
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
            <p v-if="extension.loadError">{{ extension.loadError }}</p>
            <p v-else>
              <span>v{{ extension.version }}</span>
              <small>全局</small>
              <small v-if="extension.action?.defaultPopup">可弹出面板</small>
            </p>
          </div>
          <div class="extension-card__actions">
            <ElSwitch :model-value="extension.enabled" @change="toggleGlobalExtension(extension)" />
            <button class="extension-card__delete" type="button" title="卸载" @click="uninstallGlobalExtension(extension)">
              <Delete theme="outline" size="16" />
            </button>
          </div>
        </article>

        <p v-if="filteredGlobalExtensions.length === 0" class="drawer-empty">
          {{ browser.globalExtensions.length === 0 ? '暂无全局插件' : '没有匹配的全局插件' }}
        </p>
      </section>

      <section class="extension-panel__section">
        <header class="extension-panel__head">
          <div>
            <strong>当前站点插件</strong>
            <span>只在当前站点会话中加载</span>
          </div>
        </header>

        <article
          v-for="extension in filteredSiteExtensions"
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
            <p v-if="extension.loadError">{{ extension.loadError }}</p>
            <p v-else>
              <span>v{{ extension.version }}</span>
              <small>站点</small>
              <small v-if="extension.action?.defaultPopup">可弹出面板</small>
            </p>
          </div>
          <div class="extension-card__actions">
            <ElSwitch :model-value="extension.enabled" @change="toggleSiteExtension(extension)" />
            <button class="extension-card__delete" type="button" title="卸载" @click="uninstallSiteExtension(extension)">
              <Delete theme="outline" size="16" />
            </button>
          </div>
        </article>

        <p v-if="filteredSiteExtensions.length === 0" class="drawer-empty">
          {{ browser.siteExtensions.length === 0 ? '当前站点未安装插件' : '没有匹配的站点插件' }}
        </p>
      </section>
    </div>
  </BrowserDrawer>
</template>

<style scoped>
.extension-panel {
  display: grid;
  gap: 16px;
}

.extension-hero {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: start;
  gap: 12px;
  overflow: hidden;
  border: 1px solid rgba(205, 214, 239, 0.78);
  border-radius: 10px;
  padding: 14px;
  background:
    radial-gradient(circle at 88% 0%, rgba(154, 112, 255, 0.18), transparent 32%),
    linear-gradient(135deg, rgba(255, 255, 255, 0.88), rgba(244, 247, 255, 0.78));
  box-shadow: 0 14px 34px rgba(76, 88, 136, 0.08);
}

.extension-hero__copy {
  display: grid;
  min-width: 0;
  gap: 5px;
}

.extension-hero__copy strong {
  color: #172049;
  font-size: 15px;
}

.extension-hero__copy span {
  color: #64718f;
  font-size: 12px;
  line-height: 1.5;
}

.extension-hero__badge {
  border: 1px solid rgba(101, 125, 239, 0.2);
  border-radius: 999px;
  padding: 4px 9px;
  background: rgba(239, 244, 255, 0.82);
  color: #5970e8;
  font-size: 12px;
  font-weight: 700;
}

.extension-search {
  display: grid;
  height: 38px;
  grid-template-columns: 22px minmax(0, 1fr);
  align-items: center;
  gap: 8px;
  border: 1px solid rgba(203, 213, 236, 0.92);
  border-radius: 8px;
  padding: 0 12px;
  background: rgba(255, 255, 255, 0.8);
  color: #63708c;
}

.extension-search:focus-within {
  border-color: rgba(92, 126, 247, 0.58);
  box-shadow: 0 0 0 3px rgba(103, 128, 245, 0.12);
}

.extension-search input {
  min-width: 0;
  border: 0;
  outline: 0;
  background: transparent;
  color: #202a43;
  font-size: 13px;
}

.extension-install-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
}

.extension-install-grid :deep(.el-button) {
  height: 38px;
  border-radius: 8px;
}

.extension-install-grid :deep(.el-button--primary) {
  border: 0;
  background: linear-gradient(90deg, #377dff, #9363f4);
  box-shadow: 0 12px 24px rgba(80, 113, 238, 0.2);
}

.extension-drop-hint {
  display: grid;
  grid-template-columns: 44px minmax(0, 1fr);
  align-items: center;
  gap: 12px;
  border: 1px dashed rgba(151, 169, 213, 0.72);
  border-radius: 10px;
  padding: 14px;
  background: rgba(248, 250, 255, 0.54);
}

.extension-drop-hint__icon {
  display: inline-flex;
  width: 42px;
  height: 42px;
  align-items: center;
  justify-content: center;
  border-radius: 10px;
  background: rgba(232, 238, 255, 0.95);
  color: #377dff;
}

.extension-drop-hint span:last-child {
  display: grid;
  min-width: 0;
  gap: 4px;
}

.extension-drop-hint strong {
  color: #26304d;
  font-size: 13px;
}

.extension-drop-hint small {
  color: #74809c;
  font-size: 12px;
}

.extension-summary {
  display: flex;
  min-height: 36px;
  align-items: center;
  gap: 14px;
  border: 1px solid rgba(218, 225, 244, 0.84);
  border-radius: 8px;
  padding: 0 12px;
  background: rgba(247, 249, 255, 0.76);
  color: #58657f;
  font-size: 12px;
}

.extension-summary strong {
  color: #3e68ff;
}

.extension-panel__section {
  display: grid;
  gap: 10px;
}

.extension-panel__head {
  display: flex;
  align-items: end;
  justify-content: space-between;
  gap: 16px;
  padding: 2px 0;
}

.extension-panel__head div {
  display: grid;
  min-width: 0;
  gap: 3px;
}

.extension-panel__head strong {
  color: #202a43;
  font-size: 14px;
}

.extension-panel__head span {
  color: #6b7894;
  font-size: 12px;
}

.extension-card {
  display: grid;
  min-width: 0;
  grid-template-columns: 44px minmax(0, 1fr) auto;
  align-items: center;
  gap: 12px;
  border: 1px solid rgba(213, 221, 239, 0.92);
  border-radius: 8px;
  padding: 12px;
  background: rgba(255, 255, 255, 0.78);
  box-shadow: 0 10px 24px rgba(72, 84, 132, 0.06);
}

.extension-card--error {
  border-color: rgba(255, 205, 205, 0.95);
  background: rgba(255, 248, 248, 0.86);
}

.extension-card__icon {
  display: inline-flex;
  width: 38px;
  height: 38px;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  border-radius: 10px;
  background: #eef2ff;
  color: #5f6fee;
}

.extension-card__icon img {
  width: 24px;
  height: 24px;
}

.extension-card__main {
  display: grid;
  min-width: 0;
  gap: 3px;
}

.extension-card__main strong,
.extension-card__main span,
.extension-card__main p {
  overflow: hidden;
  margin: 0;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.extension-card__main strong {
  color: #202a43;
  font-size: 14px;
}

.extension-card__main > span {
  color: #687490;
  font-size: 12px;
}

.extension-card__main p {
  display: flex;
  align-items: center;
  gap: 8px;
  color: #8290aa;
  font-size: 12px;
}

.extension-card__main small {
  border-radius: 999px;
  padding: 1px 7px;
  background: #edf3ff;
  color: #4f70e8;
  font-size: 11px;
}

.extension-card__actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.extension-card__actions button {
  display: inline-flex;
  min-width: 38px;
  height: 28px;
  align-items: center;
  justify-content: center;
  border: 1px solid rgba(204, 214, 237, 0.92);
  border-radius: 7px;
  background: rgba(255, 255, 255, 0.72);
  color: #64718f;
}

.extension-card__actions button:hover {
  background: #f3f6ff;
  color: #27324a;
}

.extension-card__actions .extension-card__delete {
  border-color: rgba(255, 205, 205, 0.95);
  color: #ff4d4f;
}

.extension-card__actions .extension-card__delete:hover {
  background: #fff5f5;
  color: #d9363e;
}
</style>
