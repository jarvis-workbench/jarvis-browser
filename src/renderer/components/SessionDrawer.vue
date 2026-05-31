<script setup lang="ts">
import { AddOne, Delete, Left, Save, TransferData } from '@icon-park/vue-next';
import { ElButton, ElCheckbox, ElInput, ElMessage } from 'element-plus';
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
  createSession: [site: Site, name: string];
  openSession: [site: Site, session: SiteSession];
  openSessions: [site: Site, sessions: SiteSession[]];
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
const creatingSession = ref(false);
const creatingSessionName = ref('');
const failedIconSrcBySiteId = ref(new Map<string, string>());
const pickerView = ref<'sites' | 'sessions'>('sites');
const selectedPickerSessionIds = ref<string[]>([]);

const isSettingsMode = computed(() => Boolean(props.settingsSiteId));

const drawerSite = computed(() => {
  if (props.settingsSiteId) {
    return browser.sites.find((site) => site.id === props.settingsSiteId) ?? null;
  }

  if (props.showSitePicker) {
    return browser.sites.find((site) => site.id === selectedDrawerSiteId.value) ?? null;
  }

  return browser.selectedSite;
});

const drawerSessions = computed(() => drawerSite.value?.sessions ?? []);
const selectedPickerSessions = computed(() => {
  const selectedSessionIds = new Set(selectedPickerSessionIds.value);
  return drawerSessions.value.filter((session) => selectedSessionIds.has(session.id));
});
const canOpenSelectedPickerSessions = computed(() => props.showSitePicker && selectedPickerSessions.value.length > 0);
const deleteSiteConfirmName = computed(() => drawerSite.value ? siteDisplayTitle(drawerSite.value) : '');
const canConfirmDeleteSite = computed(() => {
  return pendingDeleteSite.value && deleteSiteConfirmText.value.trim() === deleteSiteConfirmName.value;
});

watch(
  () => [props.modelValue, props.showSitePicker, props.settingsSiteId, browser.selectedSiteId, browser.sites.length] as const,
  ([visible]) => {
    if (!visible) {
      resetCreateSession();
      return;
    }

    selectedDrawerSiteId.value = props.showSitePicker
      ? ''
      : browser.selectedSiteId || '';
    pickerView.value = 'sites';
    selectedPickerSessionIds.value = [];
    resetDeleteSiteConfirm();
    resetCreateSession();
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

function startCreateSession() {
  if (!drawerSite.value) {
    return;
  }

  creatingSession.value = true;
  creatingSessionName.value = '';
  editingSessionId.value = null;
  editingSessionName.value = '';
  pendingClearSessionId.value = null;
  pendingDeleteSessionId.value = null;
}

function resetCreateSession() {
  creatingSession.value = false;
  creatingSessionName.value = '';
}

function submitCreateSession() {
  if (!drawerSite.value) {
    return;
  }

  const name = creatingSessionName.value.trim();
  if (!name) {
    ElMessage.error('会话名称不能为空');
    return;
  }

  emit('createSession', drawerSite.value, name);
  resetCreateSession();
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

function openPickerSite(site: Site) {
  selectedDrawerSiteId.value = site.id;
  selectedPickerSessionIds.value = [];
  pickerView.value = 'sessions';
}

function backToPickerSites() {
  pickerView.value = 'sites';
  selectedDrawerSiteId.value = '';
  selectedPickerSessionIds.value = [];
}

function openSelectedPickerSessions() {
  if (!drawerSite.value || !selectedPickerSessions.value.length) {
    return;
  }

  emit('openSessions', drawerSite.value, selectedPickerSessions.value);
  selectedPickerSessionIds.value = [];
}

function togglePickerSession(sessionId: string, checked: boolean) {
  const nextSessionIds = new Set(selectedPickerSessionIds.value);
  if (checked) {
    nextSessionIds.add(sessionId);
  } else {
    nextSessionIds.delete(sessionId);
  }
  selectedPickerSessionIds.value = [...nextSessionIds];
}

function sessionEntryUrl() {
  return drawerSite.value?.url ?? '';
}

function siteDisplayTitle(site: Site) {
  return site.title || new URL(site.url).hostname;
}

function siteInitial(site: Site) {
  return siteDisplayTitle(site).trim().slice(0, 1).toUpperCase();
}

function siteIconSrc(site: Site) {
  const src = browser.siteIconSrc(site);
  if (!src) {
    return '';
  }

  if (failedIconSrcBySiteId.value.get(site.id) === src) {
    return '';
  }

  return src;
}

function markIconFailed(site: Site) {
  const src = browser.siteIconSrc(site);
  if (!src) {
    return;
  }

  failedIconSrcBySiteId.value = new Map(failedIconSrcBySiteId.value).set(site.id, src);
}

function markIconLoaded(siteId: string) {
  if (!failedIconSrcBySiteId.value.has(siteId)) {
    return;
  }

  const nextFailures = new Map(failedIconSrcBySiteId.value);
  nextFailures.delete(siteId);
  failedIconSrcBySiteId.value = nextFailures;
}

async function openSessionSyncDialog() {
  if (!drawerSite.value) {
    return;
  }

  await browser.openSessionSyncDialog({
    scope: 'site',
    siteId: drawerSite.value.id,
  });
}
</script>

<template>
  <BrowserDrawer
    :model-value="modelValue"
    :title="isSettingsMode ? '站点设置' : showSitePicker ? '打开标签' : '会话管理'"
    width="360px"
    @update:model-value="emit('update:modelValue', $event)"
  >
    <div v-if="showSitePicker && pickerView === 'sites'" class="drawer-section picker-panel">
      <div class="drawer-title">
        <span>选择站点</span>
      </div>
      <button
        v-for="site in browser.sites"
        :key="site.id"
        class="site-picker-row"
        type="button"
        @click="openPickerSite(site)"
      >
        <span class="site-picker-row__icon">
          <img
            v-if="siteIconSrc(site)"
            :src="siteIconSrc(site)"
            alt=""
            @load="markIconLoaded(site.id)"
            @error="markIconFailed(site)"
          />
          <span v-else class="site-fallback-icon">{{ siteInitial(site) }}</span>
        </span>
        <span>
          <strong>{{ siteDisplayTitle(site) }}</strong>
          <small>{{ site.url }}</small>
        </span>
      </button>
    </div>

    <div v-if="showSitePicker && pickerView === 'sessions'" class="picker-panel picker-panel--sessions">
      <div class="picker-step-head">
        <button class="picker-step-head__back" type="button" title="返回选择站点" @click="backToPickerSites">
          <Left theme="outline" size="18" />
          <span>会话</span>
        </button>
        <ElButton v-if="canOpenSelectedPickerSessions" type="primary" size="small" @click="openSelectedPickerSessions">
          打开
        </ElButton>
      </div>

      <div v-if="drawerSite" class="drawer-section__head">
        <span class="drawer-section__site-icon">
          <img
            v-if="siteIconSrc(drawerSite)"
            :src="siteIconSrc(drawerSite)"
            alt=""
            @load="markIconLoaded(drawerSite.id)"
            @error="markIconFailed(drawerSite)"
          />
          <span v-else class="site-fallback-icon">{{ siteInitial(drawerSite) }}</span>
        </span>
        <span class="drawer-section__site-text">
          <strong>{{ siteDisplayTitle(drawerSite) }}</strong>
          <span>{{ drawerSite.url }}</span>
        </span>
      </div>

      <article
        v-for="session in drawerSessions"
        :key="session.id"
        class="session-row session-row--picker"
        :class="{ 'session-row--active': session.id === browser.selectedSessionId }"
      >
        <ElCheckbox
          :model-value="selectedPickerSessionIds.includes(session.id)"
          class="session-row__check"
          :aria-label="`选择 ${session.name}`"
          @change="togglePickerSession(session.id, Boolean($event))"
          @click.stop
        />
        <button type="button" @click="openSession(session)">
          <strong>{{ session.name }}</strong>
          <span>{{ sessionEntryUrl() }}</span>
        </button>
      </article>

      <p v-if="drawerSite && !drawerSessions.length" class="drawer-empty">这个站点还没有会话。</p>
    </div>

    <div v-if="!showSitePicker && drawerSite" class="drawer-section">
      <div class="drawer-section__head">
        <span class="drawer-section__site-icon">
          <img
            v-if="siteIconSrc(drawerSite)"
            :src="siteIconSrc(drawerSite)"
            alt=""
            @load="markIconLoaded(drawerSite.id)"
            @error="markIconFailed(drawerSite)"
          />
          <span v-else class="site-fallback-icon">{{ siteInitial(drawerSite) }}</span>
        </span>
        <span class="drawer-section__site-text">
          <strong>{{ siteDisplayTitle(drawerSite) }}</strong>
          <span>{{ isSettingsMode || showSitePicker ? drawerSite.url : selectedUrl }}</span>
        </span>
      </div>
      <div v-if="!showSitePicker" class="drawer-actions drawer-actions--sync">
        <ElButton @click="openSessionSyncDialog">
          <TransferData theme="outline" size="16" />
          导入/导出
        </ElButton>
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

    <div v-if="!showSitePicker" class="drawer-section">
      <div class="drawer-title">
        <span>会话列表</span>
        <ElButton size="small" type="primary" :disabled="!drawerSite" @click="startCreateSession">
          <AddOne theme="outline" size="16" />
          新建
        </ElButton>
      </div>

      <form v-if="creatingSession" class="session-inline session-inline--create" @submit.prevent="submitCreateSession">
        <ElInput v-model="creatingSessionName" size="small" placeholder="输入会话名称" autofocus />
        <ElButton native-type="submit" size="small" type="primary">创建</ElButton>
        <ElButton size="small" @click="resetCreateSession">取消</ElButton>
      </form>

      <article
        v-for="session in drawerSessions"
        :key="session.id"
        class="session-row"
        :class="{ 'session-row--active': session.id === browser.selectedSessionId }"
      >
        <button type="button" @click="openSession(session)">
          <strong>{{ session.name }}</strong>
          <span>{{ sessionEntryUrl() }}</span>
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
        <span>删除站点会移除该站点下的会话数据和站点扩展程序。</span>
        <button v-if="!pendingDeleteSite" class="site-danger-zone__delete" type="button" @click="beginDeleteSiteConfirm">
          <Delete theme="outline" size="16" />
          删除站点
        </button>
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
.drawer-section {
  display: grid;
  gap: 12px;
  margin-bottom: 22px;
}

.picker-panel {
  margin-bottom: 0;
}

.picker-panel--sessions {
  display: grid;
  gap: 12px;
}

.picker-step-head {
  position: sticky;
  top: -12px;
  z-index: 2;
  display: flex;
  min-height: 48px;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin: -12px -22px 0;
  padding: 10px 22px;
  border-bottom: 1px solid rgba(226, 231, 243, 0.92);
  background:
    linear-gradient(180deg, rgba(248, 250, 255, 0.98), rgba(248, 250, 255, 0.92)),
    rgba(255, 255, 255, 0.92);
  backdrop-filter: blur(18px);
}

.picker-step-head__back {
  display: inline-flex;
  min-width: 0;
  align-items: center;
  gap: 4px;
  border: 0;
  padding: 0;
  background: transparent;
  color: #1f2944;
  font-size: 15px;
  font-weight: 700;
}

.picker-step-head__back:hover {
  color: #5d6fee;
}

.picker-step-head :deep(.el-button) {
  min-width: 68px;
  border: 0;
  background: linear-gradient(90deg, #5f80ff, #7561f4);
  color: #ffffff;
}

.drawer-section__head {
  position: relative;
  display: grid;
  min-height: 96px;
  grid-template-columns: 52px minmax(0, 1fr);
  align-items: center;
  gap: 14px;
  overflow: hidden;
  border: 1px solid rgba(184, 199, 239, 0.72);
  border-radius: 8px;
  padding: 18px;
  background:
    linear-gradient(90deg, rgba(255, 255, 255, 0.76), rgba(235, 230, 255, 0.58)),
    url("/drawer-site-background.png") center / cover no-repeat;
  box-shadow:
    0 1px 0 rgba(255, 255, 255, 0.9) inset,
    0 14px 34px rgba(75, 88, 142, 0.1);
}

.drawer-section__head::after {
  position: absolute;
  right: -22px;
  bottom: -34px;
  width: 112px;
  height: 112px;
  border: 1px solid rgba(148, 161, 223, 0.18);
  border-radius: 50%;
  content: "";
}

.drawer-section__site-icon {
  display: inline-flex;
  width: 52px;
  height: 52px;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  border: 1px solid rgba(255, 255, 255, 0.82);
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.7);
  box-shadow: 0 12px 28px rgba(79, 89, 140, 0.12);
  backdrop-filter: blur(16px);
}

.drawer-section__site-icon img {
  width: 32px;
  height: 32px;
  object-fit: contain;
}

.drawer-section__site-text {
  position: relative;
  z-index: 1;
  display: grid;
  min-width: 0;
  gap: 6px;
}

.drawer-section__head strong,
.drawer-section__site-text span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.drawer-section__head strong {
  color: #1d2744;
  font-size: 16px;
  font-weight: 700;
}

.drawer-section__head span {
  color: #53617e;
  font-size: 12px;
}

.drawer-title {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  color: #1f2944;
  font-size: 14px;
  font-weight: 700;
}

.drawer-title span {
  color: #1f2944;
}

.drawer-title :deep(.el-button) {
  height: 28px;
  border-color: rgba(128, 150, 238, 0.24);
  background: rgba(244, 247, 255, 0.84);
  color: #5d6fee;
}

.site-picker-row {
  display: grid;
  width: 100%;
  min-width: 0;
  grid-template-columns: 36px minmax(0, 1fr);
  align-items: center;
  gap: 10px;
  border: 1px solid rgba(213, 221, 239, 0.92);
  border-radius: 8px;
  padding: 10px;
  background: rgba(255, 255, 255, 0.76);
  color: #202a43;
  text-align: left;
  box-shadow: 0 10px 24px rgba(72, 84, 132, 0.06);
}

.site-picker-row + .site-picker-row {
  margin-top: 8px;
}

.site-picker-row--active {
  border-color: rgba(104, 124, 242, 0.56);
  background: rgba(244, 247, 255, 0.9);
}

.site-picker-row__icon {
  display: inline-flex;
  width: 32px;
  height: 32px;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  border-radius: 8px;
  background: #eef2ff;
  color: #5f6fee;
}

.site-picker-row__icon img {
  width: 22px;
  height: 22px;
  object-fit: contain;
}

.site-picker-row span:last-child {
  display: grid;
  min-width: 0;
  gap: 3px;
}

.site-picker-row strong,
.site-picker-row small {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.site-picker-row strong {
  font-size: 13px;
}

.site-picker-row small {
  color: #687490;
  font-size: 12px;
}

.session-row {
  display: grid;
  min-width: 0;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: start;
  gap: 10px;
  border: 1px solid rgba(213, 221, 239, 0.92);
  border-radius: 8px;
  padding: 12px;
  background: rgba(255, 255, 255, 0.76);
  box-shadow: 0 10px 24px rgba(72, 84, 132, 0.06);
}

.session-row--picker {
  grid-template-columns: 24px minmax(0, 1fr);
  align-items: center;
}

.session-row__check {
  justify-self: center;
}

.session-row__check :deep(.el-checkbox__label) {
  display: none;
}

.session-row--active {
  border-color: rgba(104, 124, 242, 0.56);
  box-shadow:
    inset 3px 0 0 #6b7cff,
    0 12px 28px rgba(90, 105, 192, 0.12);
}

.session-row > button {
  display: grid;
  min-width: 0;
  gap: 4px;
  border: 0;
  padding: 0;
  background: transparent;
  color: inherit;
  text-align: left;
}

.session-row strong,
.session-row span {
  overflow: hidden;
  margin: 0;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.session-row span {
  color: #687490;
  font-size: 12px;
}

.session-row__actions {
  display: flex;
  align-items: center;
  gap: 4px;
}

.session-inline {
  display: grid;
  grid-column: 1 / -1;
  grid-template-columns: minmax(0, 1fr) auto auto;
  align-items: center;
  gap: 8px;
  border-top: 1px solid rgba(226, 231, 243, 0.9);
  padding-top: 10px;
}

.session-inline--create {
  grid-column: auto;
  grid-template-columns: minmax(0, 1fr) 58px 58px;
  gap: 8px;
  border: 1px solid rgba(213, 221, 239, 0.92);
  border-radius: 8px;
  padding: 10px 12px;
  background: rgba(255, 255, 255, 0.72);
  box-shadow: 0 10px 24px rgba(72, 84, 132, 0.05);
}

.session-inline--create :deep(.el-input__wrapper) {
  min-height: 34px;
  border-radius: 6px;
  box-shadow: 0 0 0 1px rgba(206, 216, 239, 0.9) inset;
}

.session-inline--create :deep(.el-button) {
  height: 34px;
  min-width: 58px;
  border-radius: 6px;
  padding: 0;
}

.session-inline--create :deep(.el-button--primary) {
  border: 0;
  background: linear-gradient(90deg, #5f80ff, #7561f4);
  color: #ffffff;
}

.session-inline--create :deep(.el-button--primary:hover),
.session-inline--create :deep(.el-button--primary:focus) {
  color: #ffffff;
}

.session-inline span {
  color: #687490;
  font-size: 12px;
  white-space: normal;
}

.session-inline--warning,
.session-inline--danger {
  grid-template-columns: minmax(0, 1fr) auto auto;
}

.session-inline--danger span {
  color: #c5221f;
}

.session-row__actions .session-action-text {
  display: inline-flex;
  height: 26px;
  align-items: center;
  justify-content: center;
  border: 1px solid rgba(211, 219, 240, 0.96);
  border-radius: 6px;
  padding: 0 8px;
  background: rgba(249, 251, 255, 0.76);
  color: #64718f;
  font-size: 12px;
}

.session-row__actions .session-action-text:hover {
  background: rgba(239, 244, 255, 0.95);
  color: #27324a;
}

.session-row__actions .session-action-text--danger {
  border-color: rgba(255, 205, 205, 0.95);
  color: #ff4d4f;
}

.session-row__actions .session-action-text--danger:hover {
  background: #fff5f5;
  color: #d9363e;
}

.drawer-actions--sync :deep(.el-button) {
  width: 100%;
}

.site-settings-form {
  border-bottom: 1px solid rgba(226, 231, 243, 0.9);
  padding-bottom: 18px;
}

.site-settings-form :deep(.drawer-actions) {
  display: block;
}

.site-settings-form :deep(.drawer-actions .el-button) {
  width: 100%;
  border: 0;
  background: linear-gradient(90deg, #5f80ff, #8957ee);
  box-shadow: 0 14px 28px rgba(103, 113, 239, 0.24);
}

.site-settings-form :deep(.drawer-actions .el-button:hover) {
  opacity: 0.94;
}

.site-danger-zone {
  border-top: 1px solid rgba(226, 231, 243, 0.9);
  padding-top: 16px;
}

.site-danger-zone__box {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 9px;
  border: 1px solid rgba(255, 205, 205, 0.95);
  border-radius: 8px;
  padding: 10px 12px;
  background: rgba(255, 247, 247, 0.78);
}

.site-danger-zone__box span {
  color: #ff4d4f;
  font-size: 12px;
  line-height: 1.5;
}

.site-danger-zone__delete {
  display: inline-flex;
  width: 100%;
  height: 34px;
  align-items: center;
  justify-content: center;
  gap: 6px;
  border: 1px solid #ff6b6b;
  border-radius: 18px;
  background: transparent;
  color: #ff4d4f;
  font-size: 13px;
  font-weight: 600;
}

.site-danger-zone__delete:hover {
  border-color: #ff4d4f;
  background: rgba(255, 77, 79, 0.06);
  color: #ff4d4f;
}

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
