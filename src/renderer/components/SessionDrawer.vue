<script setup lang="ts">
import { AddOne, Delete, Save } from '@icon-park/vue-next';
import { ElButton, ElInput, ElMessage } from 'element-plus';
import { computed, ref, watch } from 'vue';
import type { Site, SiteSession } from '../../shared/types';
import { useBrowserStore } from '../stores/browser';
import BrowserDrawer from './BrowserDrawer.vue';

const props = withDefaults(defineProps<{
  modelValue: boolean;
  selectedUrl: string;
  showSitePicker?: boolean;
  settingsSiteId?: string;
}>(), {
  showSitePicker: false,
});

const emit = defineEmits<{
  'update:modelValue': [value: boolean];
  createSession: [site?: Site];
  openSession: [site: Site, session: SiteSession];
}>();

const browser = useBrowserStore();
const selectedDrawerSiteId = ref('');
const editingSessionId = ref<string | null>(null);
const editingSessionName = ref('');
const pendingClearSessionId = ref<string | null>(null);
const pendingDeleteSessionId = ref<string | null>(null);
const pendingDeleteSite = ref(false);
const deleteSiteConfirmText = ref('');
const editingSiteTitle = ref('');
const editingSiteUrl = ref('');
const savingSite = ref(false);

const isSettingsMode = computed(() => Boolean(props.settingsSiteId));

const drawerSite = computed(() => {
  if (props.settingsSiteId) {
    return browser.sites.find((site) => site.id === props.settingsSiteId) ?? null;
  }

  if (props.showSitePicker) {
    return browser.sites.find((site) => site.id === selectedDrawerSiteId.value) ?? browser.sites[0] ?? null;
  }

  return browser.selectedSite;
});

const drawerSessions = computed(() => drawerSite.value?.sessions ?? []);
const deleteSiteConfirmName = computed(() => drawerSite.value ? siteDisplayTitle(drawerSite.value) : '');
const canConfirmDeleteSite = computed(() => {
  return pendingDeleteSite.value && deleteSiteConfirmText.value.trim() === deleteSiteConfirmName.value;
});

watch(
  () => [props.modelValue, props.showSitePicker, props.settingsSiteId, browser.selectedSiteId, browser.sites.length] as const,
  ([visible]) => {
    if (!visible) {
      return;
    }

    selectedDrawerSiteId.value = props.showSitePicker
      ? selectedDrawerSiteId.value || browser.selectedSiteId || browser.sites[0]?.id || ''
      : browser.selectedSiteId || '';
    resetDeleteSiteConfirm();
    editingSiteTitle.value = drawerSite.value?.title ?? '';
    editingSiteUrl.value = drawerSite.value?.url ?? '';
  },
  { immediate: true },
);

function startRenameSession(session: SiteSession) {
  editingSessionId.value = session.id;
  editingSessionName.value = session.name;
  pendingClearSessionId.value = null;
  pendingDeleteSessionId.value = null;
}

async function submitRenameSession(session: SiteSession) {
  if (props.showSitePicker) {
    return;
  }

  const name = editingSessionName.value.trim();
  if (!name) {
    ElMessage.error('名称不能为空');
    return;
  }

  try {
    await browser.renameSession(session, name);
    editingSessionId.value = null;
    editingSessionName.value = '';
  } catch (error) {
    ElMessage.error(formatError(error));
  }
}

async function clearSessionData(session: SiteSession) {
  if (props.showSitePicker) {
    return;
  }

  if (pendingClearSessionId.value !== session.id) {
    pendingClearSessionId.value = session.id;
    pendingDeleteSessionId.value = null;
    editingSessionId.value = null;
    editingSessionName.value = '';
    return;
  }

  try {
    await browser.clearSessionData(session);
    pendingClearSessionId.value = null;
  } catch (error) {
    ElMessage.error(formatError(error));
  }
}

async function deleteSession(session: SiteSession) {
  if (props.showSitePicker) {
    return;
  }

  if (pendingDeleteSessionId.value !== session.id) {
    pendingDeleteSessionId.value = session.id;
    pendingClearSessionId.value = null;
    editingSessionId.value = null;
    editingSessionName.value = '';
    return;
  }

  try {
    await browser.deleteSession(session);
    pendingDeleteSessionId.value = null;
  } catch (error) {
    ElMessage.error(formatError(error));
  }
}

async function saveSiteSettings() {
  if (!drawerSite.value || savingSite.value) {
    return;
  }

  try {
    savingSite.value = true;
    const updated = await browser.updateSite(drawerSite.value, {
      title: editingSiteTitle.value,
      url: editingSiteUrl.value,
    });
    editingSiteTitle.value = updated.title;
    editingSiteUrl.value = updated.url;
    ElMessage.success('站点已保存');
  } catch (error) {
    ElMessage.error(formatError(error));
  } finally {
    savingSite.value = false;
  }
}

function beginDeleteSiteConfirm() {
  if (!drawerSite.value) {
    return;
  }

  pendingDeleteSite.value = true;
  deleteSiteConfirmText.value = '';
}

function resetDeleteSiteConfirm() {
  pendingDeleteSite.value = false;
  deleteSiteConfirmText.value = '';
}

async function confirmDeleteSite() {
  if (!drawerSite.value || !canConfirmDeleteSite.value) {
    return;
  }

  try {
    await browser.deleteSite(drawerSite.value);
    resetDeleteSiteConfirm();
    emit('update:modelValue', false);
  } catch (error) {
    ElMessage.error(formatError(error));
  }
}

function formatError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function openSession(session: SiteSession) {
  if (!drawerSite.value) {
    return;
  }

  emit('openSession', drawerSite.value, session);
}

function siteDisplayTitle(site: Site) {
  return site.title || new URL(site.url).hostname;
}

function siteInitial(site: Site) {
  return siteDisplayTitle(site).trim().slice(0, 1).toUpperCase();
}
</script>

<template>
  <BrowserDrawer
    :model-value="modelValue"
    :title="isSettingsMode ? '站点设置' : showSitePicker ? '打开标签' : '会话管理'"
    width="360px"
    @update:model-value="emit('update:modelValue', $event)"
  >
    <div v-if="showSitePicker" class="drawer-section">
      <div class="drawer-title">
        <span>选择站点</span>
      </div>
      <button
        v-for="site in browser.sites"
        :key="site.id"
        class="site-picker-row"
        :class="{ 'site-picker-row--active': site.id === drawerSite?.id }"
        type="button"
        @click="selectedDrawerSiteId = site.id"
      >
        <span class="site-picker-row__icon">
          <img v-if="browser.siteIconSrc(site)" :src="browser.siteIconSrc(site)" alt="" />
          <span v-else class="site-fallback-icon">{{ siteInitial(site) }}</span>
        </span>
        <span>
          <strong>{{ siteDisplayTitle(site) }}</strong>
          <small>{{ site.url }}</small>
        </span>
      </button>
    </div>

    <div v-if="drawerSite" class="drawer-section">
      <div class="drawer-section__head">
        <strong>{{ siteDisplayTitle(drawerSite) }}</strong>
        <span>{{ isSettingsMode || showSitePicker ? drawerSite.url : selectedUrl }}</span>
      </div>
    </div>

    <form v-if="isSettingsMode && drawerSite" class="drawer-section site-settings-form" @submit.prevent="saveSiteSettings">
      <label class="form-field">
        <span>站点标题</span>
        <ElInput v-model="editingSiteTitle" placeholder="站点标题" clearable />
      </label>
      <label class="form-field">
        <span>站点地址</span>
        <ElInput v-model="editingSiteUrl" placeholder="站点地址" clearable />
      </label>
      <div class="drawer-actions">
        <ElButton native-type="submit" type="primary" :loading="savingSite">
          <Save theme="outline" size="16" />
          保存
        </ElButton>
      </div>
    </form>

    <div class="drawer-section">
      <div class="drawer-title">
        <span>会话列表</span>
        <ElButton size="small" type="primary" :disabled="!drawerSite" @click="emit('createSession', drawerSite || undefined)">
          <AddOne theme="outline" size="16" />
          新建
        </ElButton>
      </div>

      <article
        v-for="session in drawerSessions"
        :key="session.id"
        class="session-row"
        :class="{ 'session-row--active': session.id === browser.selectedSessionId }"
      >
        <button type="button" @click="openSession(session)">
          <strong>{{ session.name }}</strong>
          <span>{{ session.lastUrl }}</span>
        </button>
        <div v-if="!showSitePicker" class="session-row__actions">
          <button type="button" class="session-action-text" @click="startRenameSession(session)">
            重命名
          </button>
          <button type="button" class="session-action-text" @click="clearSessionData(session)">
            清空
          </button>
          <button type="button" class="session-action-text session-action-text--danger" @click="deleteSession(session)">
            删除
          </button>
        </div>
        <form v-if="!showSitePicker && editingSessionId === session.id" class="session-inline" @submit.prevent="submitRenameSession(session)">
          <ElInput v-model="editingSessionName" size="small" placeholder="会话名称" />
          <ElButton native-type="submit" size="small" type="primary">保存</ElButton>
          <ElButton size="small" @click="editingSessionId = null">取消</ElButton>
        </form>
        <div v-if="!showSitePicker && pendingClearSessionId === session.id" class="session-inline session-inline--warning">
          <span>清理该会话的 Cookie、缓存和本地存储。</span>
          <ElButton size="small" type="warning" @click="clearSessionData(session)">确认清空</ElButton>
          <ElButton size="small" @click="pendingClearSessionId = null">取消</ElButton>
        </div>
        <div v-if="!showSitePicker && pendingDeleteSessionId === session.id" class="session-inline session-inline--danger">
          <span>移除该会话。</span>
          <ElButton size="small" type="danger" @click="deleteSession(session)">确认删除</ElButton>
          <ElButton size="small" @click="pendingDeleteSessionId = null">取消</ElButton>
        </div>
      </article>
    </div>

    <div v-if="isSettingsMode && drawerSite" class="drawer-section site-danger-zone">
      <div class="drawer-title">
        <span>危险操作</span>
      </div>
      <div class="site-danger-zone__box">
        <span>删除站点会移除该站点下的会话数据和站点插件。</span>
        <ElButton v-if="!pendingDeleteSite" type="danger" plain @click="beginDeleteSiteConfirm">
          <Delete theme="outline" size="16" />
          删除站点
        </ElButton>
        <div v-else class="site-delete-confirm">
          <label class="form-field">
            <span>输入“{{ deleteSiteConfirmName }}”确认删除</span>
            <ElInput v-model="deleteSiteConfirmText" placeholder="输入站点标题" />
          </label>
          <div class="site-delete-confirm__actions">
            <ElButton @click="resetDeleteSiteConfirm">取消</ElButton>
            <ElButton type="danger" :disabled="!canConfirmDeleteSite" @click="confirmDeleteSite">
              <Delete theme="outline" size="16" />
              永久删除站点
            </ElButton>
          </div>
        </div>
      </div>
    </div>

  </BrowserDrawer>
</template>

<style scoped>
.site-delete-confirm {
  display: grid;
  gap: 12px;
}

.site-delete-confirm__actions {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
}
</style>
