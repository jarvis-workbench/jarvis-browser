<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import {
  ElButton,
  ElCheckbox,
  ElDialog,
  ElInput,
  ElMessage,
  ElOption,
  ElRadioButton,
  ElRadioGroup,
  ElSelect,
} from 'element-plus';
import type {
  SessionSyncConflictAction,
  SessionSyncPreviewImportResult,
  SessionSyncPreviewSession,
  SessionSyncPreviewSite,
  SessionSyncScope,
  Site,
} from '../../shared/types';
import { useBrowserStore } from '../stores/browser';

const props = defineProps<{
  modelValue: boolean;
  scope: SessionSyncScope;
  siteId?: string;
}>();

const emit = defineEmits<{
  'update:modelValue': [value: boolean];
}>();

type DialogMode = 'export' | 'import';

const browser = useBrowserStore();
const mode = ref<DialogMode>('export');
const selectedSiteIds = ref<string[]>([]);
const selectedSessionIds = ref<string[]>([]);
const encrypted = ref(true);
const password = ref('');
const exporting = ref(false);
const previewing = ref(false);
const applying = ref(false);
const preview = ref<SessionSyncPreviewImportResult | null>(null);
const siteConflictActions = ref<Record<string, SessionSyncConflictAction>>({});
const sessionConflictActions = ref<Record<string, SessionSyncConflictAction>>({});

const scopedSites = computed(() => {
  if (props.scope === 'site') {
    return browser.sites.filter((site) => site.id === props.siteId);
  }

  return browser.sites;
});
const dialogTitle = computed(() => (props.scope === 'site' ? '导入/导出本站登录状态' : '导入/导出登录状态'));
const selectedSessionCount = computed(() => selectedSessionIds.value.length);
const allSessionIds = computed(() => scopedSites.value.flatMap((site) => site.sessions.map((session) => session.id)));
const allSessionsSelected = computed(() => (
  allSessionIds.value.length > 0 && allSessionIds.value.every((sessionId) => selectedSessionIds.value.includes(sessionId))
));
const selectedSiteSet = computed(() => new Set(selectedSiteIds.value));
const selectedSessionSet = computed(() => new Set(selectedSessionIds.value));
const siteDuplicateCount = computed(() => preview.value?.duplicateSiteCount ?? 0);
const sessionDuplicateCount = computed(() => preview.value?.duplicateSessionCount ?? 0);
const previewSiteCount = computed(() => preview.value?.summary.totalSites ?? preview.value?.sites.length ?? 0);
const canExport = computed(() => (
  selectedSiteIds.value.length > 0
  && selectedSessionIds.value.length > 0
  && (!encrypted.value || password.value.trim().length > 0)
));
const hasPreview = computed(() => Boolean(preview.value));
const canApplyImport = computed(() => Boolean(preview.value?.importId));

watch(
  () => props.modelValue,
  (visible) => {
    if (visible) {
      resetDialog();
    } else {
      void cancelPreview();
    }
  },
);

watch(
  () => [props.scope, props.siteId, browser.sites.length] as const,
  () => {
    if (props.modelValue) {
      resetExportSelection();
    }
  },
);

function resetDialog() {
  mode.value = 'export';
  encrypted.value = true;
  password.value = '';
  exporting.value = false;
  previewing.value = false;
  applying.value = false;
  clearPreview();
  resetExportSelection();
}

function resetExportSelection() {
  selectedSiteIds.value = scopedSites.value.map((site) => site.id);
  selectedSessionIds.value = scopedSites.value.flatMap((site) => site.sessions.map((session) => session.id));
}

function updateVisible(value: boolean) {
  emit('update:modelValue', value);
}

function toggleSite(site: Site, checked: boolean) {
  const nextSites = new Set(selectedSiteIds.value);
  const nextSessions = new Set(selectedSessionIds.value);
  if (checked) {
    nextSites.add(site.id);
    for (const session of site.sessions) {
      nextSessions.add(session.id);
    }
  } else {
    nextSites.delete(site.id);
    for (const session of site.sessions) {
      nextSessions.delete(session.id);
    }
  }

  selectedSiteIds.value = [...nextSites];
  selectedSessionIds.value = [...nextSessions];
}

function toggleSession(site: Site, sessionId: string, checked: boolean) {
  const nextSessions = new Set(selectedSessionIds.value);
  if (checked) {
    nextSessions.add(sessionId);
  } else {
    nextSessions.delete(sessionId);
  }
  selectedSessionIds.value = [...nextSessions];

  const siteHasSelectedSession = site.sessions.some((session) => nextSessions.has(session.id));
  const nextSites = new Set(selectedSiteIds.value);
  if (siteHasSelectedSession) {
    nextSites.add(site.id);
  } else {
    nextSites.delete(site.id);
  }
  selectedSiteIds.value = [...nextSites];
}

function toggleAllSessions(checked: boolean) {
  if (checked) {
    selectedSiteIds.value = scopedSites.value.map((site) => site.id);
    selectedSessionIds.value = allSessionIds.value;
    return;
  }

  selectedSiteIds.value = [];
  selectedSessionIds.value = [];
}

async function exportLoginState() {
  if (!canExport.value || exporting.value) {
    return;
  }

  try {
    exporting.value = true;
    const result = await browser.exportSessionSync({
      scope: props.scope,
      siteId: props.siteId,
      siteIds: selectedSiteIds.value,
      sessionIds: selectedSessionIds.value,
      sessions: exportSelections(),
      encrypted: encrypted.value,
      password: encrypted.value ? password.value : undefined,
    });
    if (result.canceled) {
      return;
    }
    const detail = result.filePath ? `：${result.filePath}` : '';
    ElMessage.success(`登录状态已导出${detail}`);
    updateVisible(false);
  } catch (error) {
    ElMessage.error(formatError(error));
  } finally {
    exporting.value = false;
  }
}

async function previewImport() {
  if (previewing.value) {
    return;
  }

  try {
    previewing.value = true;
    clearPreview();
    const result = await browser.previewSessionSyncImport({
      scope: props.scope,
      siteId: props.siteId,
    });
    if (!result) {
      return;
    }
    if (result.canceled) {
      return;
    }
    if (!result.importId) {
      throw new Error('导入预览缺少任务编号');
    }
    preview.value = result;
    seedConflictActions(result);
  } catch (error) {
    ElMessage.error(formatError(error));
  } finally {
    previewing.value = false;
  }
}

async function applyImport() {
  if (!preview.value?.importId || applying.value) {
    return;
  }

  try {
    applying.value = true;
    await browser.applySessionSyncImport({
      importId: preview.value.importId,
      scope: props.scope,
      siteId: props.siteId,
      siteConflicts: siteConflictActions.value,
      sessionConflicts: sessionConflictActions.value,
    });
    clearPreview();
    ElMessage.success('登录状态已导入');
    updateVisible(false);
  } catch (error) {
    ElMessage.error(formatError(error));
  } finally {
    applying.value = false;
  }
}

function exportSelections() {
  const selectedSessions = new Set(selectedSessionIds.value);
  return scopedSites.value.flatMap((site) =>
    site.sessions
      .filter((session) => selectedSessions.has(session.id))
      .map((session) => ({
        siteId: site.id,
        sessionId: session.id,
      })),
  );
}

async function cancelPreview() {
  const importId = preview.value?.importId;
  if (!importId) {
    return;
  }

  try {
    await browser.cancelSessionSyncImport(importId);
  } catch {
    // Closing the dialog should not block on cleanup failure.
  } finally {
    clearPreview();
  }
}

function seedConflictActions(result: SessionSyncPreviewImportResult) {
  const nextSiteActions: Record<string, SessionSyncConflictAction> = {};
  const nextSessionActions: Record<string, SessionSyncConflictAction> = {};
  for (const site of result.sites) {
    if (hasSiteConflict(site)) {
      nextSiteActions[site.id] = 'skip';
    }
    for (const session of site.sessions) {
      if (hasSessionConflict(session)) {
        nextSessionActions[sessionKey(site, session)] = 'skip';
      }
    }
  }
  siteConflictActions.value = nextSiteActions;
  sessionConflictActions.value = nextSessionActions;
}

function clearPreview() {
  preview.value = null;
  siteConflictActions.value = {};
  sessionConflictActions.value = {};
}

function setAllSiteConflictActions(action: SessionSyncConflictAction) {
  if (!preview.value) {
    return;
  }

  const next = { ...siteConflictActions.value };
  for (const site of preview.value.sites) {
    if (hasSiteConflict(site)) {
      next[site.id] = action;
    }
  }
  siteConflictActions.value = next;
}

function setAllSessionConflictActions(action: SessionSyncConflictAction) {
  if (!preview.value) {
    return;
  }

  const next = { ...sessionConflictActions.value };
  for (const site of preview.value.sites) {
    for (const session of site.sessions) {
      if (hasSessionConflict(session)) {
        next[sessionKey(site, session)] = action;
      }
    }
  }
  sessionConflictActions.value = next;
}

function sessionKey(site: SessionSyncPreviewSite, session: SessionSyncPreviewSession) {
  return `${site.id}:${session.id}`;
}

function hasSiteConflict(site: SessionSyncPreviewSite) {
  return Boolean(site.duplicate || site.conflict !== 'none');
}

function hasSessionConflict(session: SessionSyncPreviewSession) {
  return Boolean(session.duplicate || session.conflict !== 'none');
}

function siteTitle(site: Site | SessionSyncPreviewSite) {
  return site.title || new URL(site.url).hostname;
}

function formatError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
</script>

<template>
  <ElDialog
    :model-value="modelValue"
    :title="dialogTitle"
    width="720px"
    class="session-sync-dialog"
    append-to-body
    destroy-on-close
    @update:model-value="updateVisible"
  >
    <div class="session-sync">
      <ElRadioGroup v-model="mode" class="session-sync__mode">
        <ElRadioButton label="export">导出</ElRadioButton>
        <ElRadioButton label="import">导入</ElRadioButton>
      </ElRadioGroup>

      <section v-if="mode === 'export'" class="session-sync__body">
        <div class="session-sync__toolbar">
          <ElCheckbox :model-value="allSessionsSelected" :disabled="!allSessionIds.length" @change="toggleAllSessions(Boolean($event))">
            全选
          </ElCheckbox>
          <span>{{ selectedSessionCount }} 个对话</span>
        </div>

        <div class="session-sync__tree">
          <article v-for="site in scopedSites" :key="site.id" class="sync-site">
            <ElCheckbox
              :model-value="selectedSiteSet.has(site.id)"
              @change="toggleSite(site, Boolean($event))"
            >
              <span class="sync-site__title">{{ siteTitle(site) }}</span>
            </ElCheckbox>
            <span class="sync-site__url">{{ site.url }}</span>
            <div class="sync-sessions">
              <ElCheckbox
                v-for="session in site.sessions"
                :key="session.id"
                :model-value="selectedSessionSet.has(session.id)"
                @change="toggleSession(site, session.id, Boolean($event))"
              >
                {{ session.name }}
              </ElCheckbox>
            </div>
          </article>
          <p v-if="!scopedSites.length" class="session-sync__empty">没有可导出的站点。</p>
        </div>

        <div class="session-sync__options">
          <ElCheckbox v-model="encrypted">加密导出</ElCheckbox>
          <ElInput
            v-if="encrypted"
            v-model="password"
            type="password"
            show-password
            placeholder="输入导出密码"
          />
        </div>
      </section>

      <section v-else class="session-sync__body">
        <div class="session-sync__toolbar">
          <ElButton type="primary" :loading="previewing" @click="previewImport">
            选择文件
          </ElButton>
          <span v-if="preview?.fileName">{{ preview.fileName }}</span>
        </div>

        <div v-if="hasPreview" class="session-sync__preview">
          <div class="session-sync__summary">
            <span>{{ previewSiteCount }} 个站点</span>
            <span>{{ siteDuplicateCount }} 个重复站点</span>
            <span>{{ sessionDuplicateCount }} 个重复对话</span>
          </div>

          <div v-if="siteDuplicateCount > 1 || sessionDuplicateCount > 1" class="session-sync__bulk">
            <ElButton v-if="siteDuplicateCount > 1" size="small" @click="setAllSiteConflictActions('overwrite-all')">
              站点全部覆盖
            </ElButton>
            <ElButton v-if="sessionDuplicateCount > 1" size="small" @click="setAllSessionConflictActions('overwrite-all')">
              对话全部覆盖
            </ElButton>
          </div>

          <div class="session-sync__tree">
            <article v-for="site in preview?.sites" :key="site.id" class="sync-site">
              <div class="sync-site__preview-head">
                <div>
                  <strong>{{ siteTitle(site) }}</strong>
                  <span>{{ site.url }}</span>
                </div>
                <ElSelect
                  v-if="hasSiteConflict(site)"
                  v-model="siteConflictActions[site.id]"
                  size="small"
                  class="sync-conflict-select"
                >
                  <ElOption label="跳过" value="skip" />
                  <ElOption label="覆盖" value="overwrite" />
                  <ElOption v-if="siteDuplicateCount > 1" label="全部覆盖" value="overwrite-all" />
                </ElSelect>
              </div>
              <div class="sync-sessions">
                <div v-for="session in site.sessions" :key="session.id" class="sync-session-preview">
                  <span>{{ session.name }}</span>
                  <ElSelect
                    v-if="hasSessionConflict(session)"
                    v-model="sessionConflictActions[sessionKey(site, session)]"
                    size="small"
                    class="sync-conflict-select"
                  >
                    <ElOption label="跳过" value="skip" />
                    <ElOption label="覆盖" value="overwrite" />
                    <ElOption v-if="sessionDuplicateCount > 1" label="全部覆盖" value="overwrite-all" />
                  </ElSelect>
                </div>
              </div>
            </article>
          </div>
        </div>

        <p v-else class="session-sync__empty">选择备份文件后，会在这里预览将要导入的站点和对话。</p>
      </section>
    </div>

    <template #footer>
      <div class="session-sync__footer">
        <ElButton @click="updateVisible(false)">取消</ElButton>
        <ElButton
          v-if="mode === 'export'"
          type="primary"
          :disabled="!canExport"
          :loading="exporting"
          @click="exportLoginState"
        >
          导出
        </ElButton>
        <ElButton
          v-else
          type="primary"
          :disabled="!canApplyImport"
          :loading="applying"
          @click="applyImport"
        >
          导入
        </ElButton>
      </div>
    </template>
  </ElDialog>
</template>

<style scoped>
:global(.session-sync-dialog) {
  z-index: 3000;
}

.session-sync {
  display: grid;
  min-width: 0;
  gap: 14px;
}

.session-sync__mode {
  justify-self: start;
}

.session-sync__body {
  display: grid;
  min-width: 0;
  gap: 12px;
}

.session-sync__toolbar,
.session-sync__summary,
.session-sync__bulk,
.session-sync__footer {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

.session-sync__toolbar,
.session-sync__summary {
  color: #5f6b82;
  font-size: 13px;
}

.session-sync__tree {
  display: grid;
  max-height: 360px;
  min-width: 0;
  gap: 10px;
  overflow-y: auto;
  overflow-x: hidden;
  padding-right: 4px;
}

.sync-site {
  display: grid;
  min-width: 0;
  gap: 8px;
  border: 1px solid rgba(213, 221, 239, 0.92);
  border-radius: 8px;
  padding: 12px;
  background: #ffffff;
}

.sync-site__title {
  font-weight: 600;
}

.sync-site__url,
.sync-site__preview-head span {
  display: block;
  overflow: hidden;
  color: #667085;
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.sync-sessions {
  display: grid;
  min-width: 0;
  gap: 8px;
  padding-left: 24px;
}

.sync-site__preview-head,
.sync-session-preview {
  display: grid;
  min-width: 0;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 10px;
}

.sync-site__preview-head strong,
.sync-session-preview span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.sync-conflict-select {
  width: 112px;
}

.session-sync__options {
  display: grid;
  min-width: 0;
  gap: 8px;
}

.session-sync__empty {
  margin: 0;
  color: #667085;
  font-size: 13px;
}

.session-sync__footer {
  justify-content: flex-end;
}
</style>
