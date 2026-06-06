<script setup lang="ts">
import { Delete, Refresh, Search, Time } from '@icon-park/vue-next';
import { ElButton, ElInput, ElMessage, ElSelect, ElOption } from 'element-plus';
import { computed, onMounted, ref } from 'vue';
import type { HistoryClearInput, HistoryListInput, HistoryRecord } from '../../shared/types';
import { useBrowserStore } from '../stores/browser';
import { formatError } from '../../shared/utils';

const browser = useBrowserStore();
const records = ref<HistoryRecord[]>([]);
const loading = ref(false);
const searchText = ref('');
const siteId = ref('');
const origin = ref('');
const limit = ref(200);

const filteredRecords = computed(() => {
  const keyword = searchText.value.trim().toLowerCase();

  return records.value.filter((record) => {
    if (siteId.value && record.siteId !== siteId.value) {
      return false;
    }

    if (origin.value && record.origin !== origin.value) {
      return false;
    }

    if (!keyword) {
      return true;
    }

    return [
      record.title,
      record.url,
      record.origin,
      siteSessionText(record),
    ].some((value) => value?.toLowerCase().includes(keyword));
  });
});

const siteOptions = computed(() => browser.sites.filter((site) => records.value.some((record) => record.siteId === site.id)));
const originOptions = computed(() => unique(
  records.value
    .filter((record) => !siteId.value || record.siteId === siteId.value)
    .map((record) => record.origin),
));
const selectedSite = computed(() => browser.sites.find((site) => site.id === siteId.value) ?? null);

onMounted(() => {
  void loadHistory();
});

async function loadHistory() {
  try {
    loading.value = true;
    records.value = await window.appApi.history.list(createListInput());
  } catch (error) {
    ElMessage.error(formatError(error));
  } finally {
    loading.value = false;
  }
}

async function clearCurrentHistory() {
  if (!window.confirm('清理当前筛选条件下的历史记录？')) {
    return;
  }

  try {
    await window.appApi.history.clear(createClearInput());
    await loadHistory();
    ElMessage.success('历史记录已清理');
  } catch (error) {
    ElMessage.error(formatError(error));
  }
}

async function clearOrigin(record: HistoryRecord) {
  if (!window.confirm(`清理 ${record.origin} 的历史记录？`)) {
    return;
  }

  try {
    await window.appApi.history.clear({
      siteId: record.siteId,
      sessionId: record.sessionId,
      origin: record.origin,
    });
    await loadHistory();
    ElMessage.success('站点历史已清理');
  } catch (error) {
    ElMessage.error(formatError(error));
  }
}

function createListInput(): HistoryListInput {
  return {
    ...createClearInput(),
    limit: limit.value,
  };
}

function createClearInput(): HistoryClearInput {
  return {
    siteId: siteId.value.trim() || undefined,
    origin: origin.value.trim() || undefined,
  };
}

function recordTitle(record: HistoryRecord) {
  return record.title || hostText(record.url) || record.url;
}

function hostText(url: string) {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

function dateText(value: string) {
  return new Date(value).toLocaleString();
}

function siteSessionText(record: HistoryRecord) {
  const site = record.siteId ? browser.sites.find((item) => item.id === record.siteId) : undefined;
  const session = record.sessionId ? site?.sessions.find((item) => item.id === record.sessionId) : undefined;
  if (site && session) {
    return `${browser.siteDisplayTitle(site)} / ${session.name}`;
  }
  if (site) {
    return browser.siteDisplayTitle(site);
  }

  return '默认浏览';
}

function unique(values: string[]) {
  return [...new Set(values.filter(Boolean))].sort();
}


</script>

<template>
  <main class="history-page">
    <section class="history-page__body">
      <header class="history-page__head">
        <span class="history-page__title">
          <Time theme="outline" size="22" />
          <strong>历史记录</strong>
        </span>
        <div class="history-page__actions">
          <ElButton :loading="loading" @click="loadHistory">
            <Refresh theme="outline" size="16" />
            刷新
          </ElButton>
          <ElButton type="danger" plain :disabled="loading" @click="clearCurrentHistory">
            <Delete theme="outline" size="16" />
            清理当前条件
          </ElButton>
        </div>
      </header>

      <section class="history-filters" aria-label="历史记录筛选">
        <ElInput v-model="searchText" clearable placeholder="搜索标题、网址或来源">
          <template #prefix>
            <Search theme="outline" size="15" />
          </template>
        </ElInput>
        <ElSelect v-model="siteId" clearable filterable placeholder="全部站点">
          <ElOption
            v-for="site in siteOptions"
            :key="site.id"
            :label="browser.siteDisplayTitle(site)"
            :value="site.id"
          />
        </ElSelect>
        <ElSelect v-model="origin" clearable filterable placeholder="全部来源">
          <ElOption
            v-for="item in originOptions"
            :key="item"
            :label="item"
            :value="item"
          />
        </ElSelect>
        <ElSelect v-model="limit" placeholder="数量">
          <ElOption :value="100" label="100 条" />
          <ElOption :value="200" label="200 条" />
          <ElOption :value="500" label="500 条" />
          <ElOption :value="1000" label="1000 条" />
        </ElSelect>
      </section>

      <div class="history-page__summary">
        <span>{{ filteredRecords.length }} 条记录</span>
        <span v-if="selectedSite">站点：{{ browser.siteDisplayTitle(selectedSite) }}</span>
        <span v-if="origin">来源：{{ origin }}</span>
      </div>

      <p v-if="!filteredRecords.length" class="history-empty">
        暂无历史记录
      </p>

      <article
        v-for="record in filteredRecords"
        :key="record.id"
        class="history-row"
      >
        <span class="history-row__icon">
          <Time theme="outline" size="18" />
        </span>
        <div class="history-row__main">
          <strong>{{ recordTitle(record) }}</strong>
          <a :href="record.url" target="_blank" rel="noreferrer">{{ record.url }}</a>
          <div class="history-row__meta">
            <span>{{ record.origin }}</span>
            <span>{{ siteSessionText(record) }}</span>
            <span>{{ dateText(record.visitedAt) }}</span>
          </div>
        </div>
        <button type="button" title="清理此来源" @click="clearOrigin(record)">
          <Delete theme="outline" size="16" />
        </button>
      </article>
    </section>
  </main>
</template>

<style scoped>
.history-page {
  min-height: 100%;
  overflow: visible;
  background: #f8fafc;
}

.history-page__body {
  display: grid;
  width: min(1080px, 100%);
  align-content: start;
  gap: 14px;
  margin: 0 auto;
  padding: 30px;
}

.history-page__head,
.history-page__actions,
.history-page__title,
.history-page__summary,
.history-row__meta {
  display: flex;
  align-items: center;
}

.history-page__head {
  justify-content: space-between;
  gap: 16px;
}

.history-page__title {
  min-width: 0;
  gap: 10px;
  color: #202124;
  font-size: 22px;
}

.history-page__actions {
  gap: 8px;
}

.history-filters {
  display: grid;
  grid-template-columns: minmax(240px, 1fr) minmax(160px, 220px) minmax(200px, 260px) 120px;
  gap: 10px;
}

.history-page__summary {
  gap: 12px;
  color: #5f6368;
  font-size: 12px;
}

.history-empty {
  margin: 0;
  border: 1px dashed #dadce0;
  border-radius: 8px;
  padding: 28px;
  background: #ffffff;
  color: #5f6368;
  font-size: 13px;
  text-align: center;
}

.history-row {
  display: grid;
  grid-template-columns: 40px minmax(0, 1fr) 34px;
  align-items: center;
  gap: 14px;
  border: 1px solid #dadce0;
  border-radius: 8px;
  padding: 14px;
  background: #ffffff;
}

.history-row__icon {
  display: inline-flex;
  width: 40px;
  height: 40px;
  align-items: center;
  justify-content: center;
  border-radius: 8px;
  background: #e8f0fe;
  color: #1a73e8;
}

.history-row__main {
  display: grid;
  min-width: 0;
  gap: 5px;
}

.history-row__main strong,
.history-row__main a,
.history-row__meta span {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.history-row__main strong {
  color: #202124;
  font-size: 14px;
}

.history-row__main a {
  color: #1a73e8;
  font-size: 12px;
  text-decoration: none;
}

.history-row__meta {
  min-width: 0;
  gap: 12px;
  color: #5f6368;
  font-size: 12px;
}

.history-row button {
  display: inline-flex;
  width: 32px;
  height: 32px;
  align-items: center;
  justify-content: center;
  border: 0;
  border-radius: 50%;
  background: transparent;
  color: #3c4043;
}

.history-row button:hover {
  background: #f1f3f4;
}
</style>
