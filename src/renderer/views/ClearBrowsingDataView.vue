<script setup lang="ts">
import { Delete, Refresh, Search } from '@icon-park/vue-next';
import { ElButton, ElCheckbox, ElInput, ElMessage, ElOption, ElSelect } from 'element-plus';
import { computed, onMounted, ref, watch } from 'vue';
import type {
  BrowserStorageType,
  StorageClearDataInput,
  StoragePartitionStats,
  StorageStatsInput,
} from '../../shared/types';
import { formatError } from '../../shared/utils';

const storageStats = ref<StoragePartitionStats[]>([]);
const selectedPartition = ref('');
const selectedOrigin = ref('');
const originSearch = ref('');
const clearHistory = ref(true);
const clearCookies = ref(true);
const clearCache = ref(true);
const clearStorage = ref(true);
const loading = ref(false);
const clearing = ref(false);

const filteredStats = computed(() => {
  if (!selectedPartition.value) {
    return storageStats.value;
  }

  return storageStats.value.filter((item) => item.partition === selectedPartition.value);
});

const originOptions = computed(() => {
  const keyword = originSearch.value.trim().toLowerCase();
  const origins = filteredStats.value.flatMap((partition) => partition.origins.map((origin) => origin.origin));
  return unique(origins).filter((origin) => !keyword || origin.toLowerCase().includes(keyword));
});

const displayedStats = computed(() => filteredStats.value.map((partitionStats) => {
  const keyword = originSearch.value.trim().toLowerCase();
  const origins = partitionStats.origins.filter((origin) => {
    if (selectedOrigin.value && origin.origin !== selectedOrigin.value) {
      return false;
    }

    return !keyword || origin.origin.toLowerCase().includes(keyword);
  });

  return {
    ...partitionStats,
    originCount: origins.length,
    origins,
  };
}).filter((partitionStats) => partitionStats.origins.length || !selectedOrigin.value));

const totalOriginCount = computed(() => displayedStats.value.reduce((total, item) => total + item.originCount, 0));
const totalCacheBytes = computed(() => filteredStats.value.reduce((total, item) => total + item.cacheBytes, 0));
const totalHistoryCount = computed(() =>
  displayedStats.value.reduce((total, partitionStats) =>
    total + partitionStats.origins.reduce((originTotal, origin) => originTotal + origin.historyCount, 0), 0),
);
const totalCookieCount = computed(() =>
  displayedStats.value.reduce((total, partitionStats) =>
    total + partitionStats.origins.reduce((originTotal, origin) => originTotal + origin.cookieCount, 0), 0),
);

const canClear = computed(() => clearHistory.value || clearCookies.value || clearCache.value || clearStorage.value);

onMounted(() => {
  void loadStats();
});

watch(selectedPartition, () => {
  if (selectedOrigin.value && !originOptions.value.includes(selectedOrigin.value)) {
    selectedOrigin.value = '';
  }
});

async function loadStats() {
  try {
    loading.value = true;
    storageStats.value = await getStorageStats();
  } catch (error) {
    ElMessage.error(formatError(error));
  } finally {
    loading.value = false;
  }
}

async function clearBrowsingData() {
  if (!canClear.value || !window.confirm('清理选中的浏览数据？')) {
    return;
  }

  try {
    clearing.value = true;
    const partitionTargets = selectedPartition.value
      ? [selectedPartition.value]
      : storageStats.value.map((item) => item.partition);

    if (clearHistory.value) {
      await window.appApi.history.clear({
        partition: selectedPartition.value || undefined,
        origin: selectedOrigin.value || undefined,
      });
    }

    const storages = selectedStorages();
    if ((storages.length || clearCache.value) && !partitionTargets.length) {
      throw new Error('没有可清理的浏览器分区');
    }

    await Promise.all(partitionTargets.map((partition) => {
      if (!storages.length && !clearCache.value) {
        return Promise.resolve();
      }

      const input: StorageClearDataInput = {
        partition,
        origin: selectedOrigin.value || undefined,
        storages,
        clearCache: clearCache.value,
      };
      return window.appApi.storage.clearData(input);
    }));

    await loadStats();
    ElMessage.success('浏览数据已清理');
  } catch (error) {
    ElMessage.error(formatError(error));
  } finally {
    clearing.value = false;
  }
}

async function getStorageStats(input?: StorageStatsInput) {
  return window.appApi.storage.stats(input);
}

function selectedStorages(): BrowserStorageType[] {
  return [
    ...(clearCookies.value ? ['cookies' as const] : []),
    ...(clearStorage.value ? [
      'filesystem' as const,
      'indexdb' as const,
      'localstorage' as const,
      'shadercache' as const,
      'websql' as const,
      'serviceworkers' as const,
      'cachestorage' as const,
    ] : []),
  ];
}

function sizeText(bytes: number) {
  if (!bytes) {
    return '0 B';
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

function dateText(value?: string) {
  return value ? new Date(value).toLocaleString() : '无历史访问';
}

function unique(values: string[]) {
  return [...new Set(values.filter(Boolean))].sort();
}


</script>

<template>
  <main class="clear-data-page">
    <section class="clear-data-page__body">
      <header class="clear-data-page__head">
        <span class="clear-data-page__title">
          <Delete theme="outline" size="22" />
          <strong>清理浏览数据</strong>
        </span>
        <ElButton :loading="loading" @click="loadStats">
          <Refresh theme="outline" size="16" />
          刷新
        </ElButton>
      </header>

      <section class="clear-data-grid" aria-label="浏览数据清理">
        <aside class="clear-data-panel">
          <label class="clear-data-field">
            <span>分区</span>
            <ElSelect v-model="selectedPartition" clearable filterable placeholder="全部分区">
              <ElOption
                v-for="item in storageStats"
                :key="item.partition"
                :label="item.partition"
                :value="item.partition"
              />
            </ElSelect>
          </label>

          <label class="clear-data-field">
            <span>来源</span>
            <ElInput v-model="originSearch" clearable placeholder="搜索来源">
              <template #prefix>
                <Search theme="outline" size="15" />
              </template>
            </ElInput>
            <ElSelect v-model="selectedOrigin" clearable filterable placeholder="全部来源">
              <ElOption
                v-for="origin in originOptions"
                :key="origin"
                :label="origin"
                :value="origin"
              />
            </ElSelect>
          </label>

          <div class="clear-data-options" aria-label="清理项目">
            <ElCheckbox v-model="clearHistory">历史记录</ElCheckbox>
            <ElCheckbox v-model="clearCookies">Cookie</ElCheckbox>
            <ElCheckbox v-model="clearCache">缓存</ElCheckbox>
            <ElCheckbox v-model="clearStorage">本地存储</ElCheckbox>
          </div>

          <ElButton
            type="danger"
            :disabled="!canClear"
            :loading="clearing"
            @click="clearBrowsingData"
          >
            <Delete theme="outline" size="16" />
            清理
          </ElButton>
        </aside>

        <section class="clear-data-content" aria-label="浏览数据统计">
          <div class="clear-data-summary">
            <span>
              <strong>{{ displayedStats.length }}</strong>
              分区
            </span>
            <span>
              <strong>{{ totalOriginCount }}</strong>
              来源
            </span>
            <span>
              <strong>{{ totalHistoryCount }}</strong>
              历史
            </span>
            <span>
              <strong>{{ totalCookieCount }}</strong>
              Cookie
            </span>
            <span>
              <strong>{{ sizeText(totalCacheBytes) }}</strong>
              缓存
            </span>
          </div>

          <p v-if="!displayedStats.length" class="clear-data-empty">
            暂无可展示的浏览数据
          </p>

          <article
            v-for="partitionStats in displayedStats"
            :key="partitionStats.partition"
            class="partition-block"
          >
            <header>
              <strong>{{ partitionStats.partition }}</strong>
              <span>{{ partitionStats.originCount }} 个来源 · {{ sizeText(partitionStats.cacheBytes) }} 缓存</span>
            </header>

            <div class="origin-list">
              <div
                v-for="origin in partitionStats.origins"
                :key="`${partitionStats.partition}:${origin.origin}`"
                class="origin-row"
              >
                <span class="origin-row__main">
                  <strong>{{ origin.origin }}</strong>
                  <small>{{ dateText(origin.lastVisitedAt) }}</small>
                </span>
                <span>{{ origin.historyCount }} 历史</span>
                <span>{{ origin.cookieCount }} Cookie</span>
                <span>{{ sizeText(origin.cookieBytes) }}</span>
              </div>
            </div>
          </article>
        </section>
      </section>
    </section>
  </main>
</template>

<style scoped>
.clear-data-page {
  min-height: 100%;
  overflow: visible;
  background: #f8fafc;
}

.clear-data-page__body {
  display: grid;
  width: min(1120px, 100%);
  align-content: start;
  gap: 16px;
  margin: 0 auto;
  padding: 30px;
}

.clear-data-page__head,
.clear-data-page__title,
.clear-data-summary,
.partition-block header,
.origin-row {
  display: flex;
  align-items: center;
}

.clear-data-page__head {
  justify-content: space-between;
  gap: 16px;
}

.clear-data-page__title {
  gap: 10px;
  color: #202124;
  font-size: 22px;
}

.clear-data-grid {
  display: grid;
  grid-template-columns: 280px minmax(0, 1fr);
  gap: 22px;
}

.clear-data-panel,
.clear-data-content,
.partition-block {
  border: 1px solid #dadce0;
  border-radius: 8px;
  background: #ffffff;
}

.clear-data-panel {
  display: grid;
  align-content: start;
  gap: 16px;
  padding: 16px;
}

.clear-data-field {
  display: grid;
  gap: 8px;
}

.clear-data-field > span {
  color: #3c4043;
  font-size: 13px;
  font-weight: 600;
}

.clear-data-options {
  display: grid;
  gap: 6px;
}

.clear-data-content {
  display: grid;
  min-width: 0;
  align-content: start;
  gap: 12px;
  padding: 16px;
}

.clear-data-summary {
  flex-wrap: wrap;
  gap: 10px;
}

.clear-data-summary span {
  display: inline-flex;
  height: 32px;
  align-items: center;
  gap: 6px;
  border-radius: 999px;
  padding: 0 12px;
  background: #f1f3f4;
  color: #5f6368;
  font-size: 12px;
}

.clear-data-summary strong {
  color: #202124;
}

.clear-data-empty {
  margin: 0;
  border: 1px dashed #dadce0;
  border-radius: 8px;
  padding: 28px;
  color: #5f6368;
  font-size: 13px;
  text-align: center;
}

.partition-block {
  overflow: hidden;
}

.partition-block header {
  justify-content: space-between;
  gap: 14px;
  border-bottom: 1px solid #edf0f2;
  padding: 12px 14px;
}

.partition-block header strong {
  min-width: 0;
  overflow: hidden;
  color: #202124;
  font-size: 14px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.partition-block header span {
  flex: 0 0 auto;
  color: #5f6368;
  font-size: 12px;
}

.origin-list {
  display: grid;
}

.origin-row {
  min-width: 0;
  gap: 14px;
  padding: 11px 14px;
  color: #5f6368;
  font-size: 12px;
}

.origin-row + .origin-row {
  border-top: 1px solid #f1f3f4;
}

.origin-row__main {
  display: grid;
  min-width: 0;
  flex: 1 1 auto;
  gap: 3px;
}

.origin-row__main strong,
.origin-row__main small {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.origin-row__main strong {
  color: #202124;
  font-size: 13px;
}

.origin-row__main small {
  color: #7a8087;
  font-size: 11px;
}

.origin-row > span:not(.origin-row__main) {
  flex: 0 0 auto;
}
</style>
