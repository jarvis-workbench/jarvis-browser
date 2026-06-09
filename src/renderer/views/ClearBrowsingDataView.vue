<script setup lang="ts">
import { Delete, Refresh, Search } from '@icon-park/vue-next';
import { ElButton, ElInput, ElMessage, ElOption, ElSelect } from 'element-plus';
import { computed, onMounted, ref } from 'vue';
import type {
  HistoryRecord,
  Site,
  SiteSession,
  StoragePartitionStats,
} from '../../shared/types';
import { createSessionPartition } from '../../shared/session-partitions';
import { useBrowserStore } from '../stores/browser';
import { formatError } from '../../shared/utils';

type CacheTarget = {
  partition: string;
  site: Site;
  session: SiteSession;
  cacheBytes: number;
  historyCount: number;
  lastVisitedAt?: string;
};

type SiteGroup = {
  site: Site;
  cacheBytes: number;
  historyCount: number;
  lastVisitedAt?: string;
  targets: CacheTarget[];
};

const browser = useBrowserStore();
const storageStats = ref<StoragePartitionStats[]>([]);
const historyRecords = ref<HistoryRecord[]>([]);
const selectedSiteId = ref('');
const searchText = ref('');
const loading = ref(false);
const clearing = ref(false);

const cacheTargets = computed<CacheTarget[]>(() => {
  const statsByPartition = new Map(storageStats.value.map((item) => [item.partition, item]));
  const historyByPartition = new Map<string, { count: number; lastVisitedAt?: string }>();

  for (const record of historyRecords.value) {
    const current = historyByPartition.get(record.partition) ?? { count: 0 };
    current.count += 1;
    if (!current.lastVisitedAt || record.visitedAt > current.lastVisitedAt) {
      current.lastVisitedAt = record.visitedAt;
    }
    historyByPartition.set(record.partition, current);
  }

  return browser.sites
    .flatMap((site) => site.sessions.map((session) => {
      const partition = createSessionPartition(site.id, session.id);
      const stats = statsByPartition.get(partition);
      const history = historyByPartition.get(partition);

      return {
        partition,
        site,
        session,
        cacheBytes: stats?.cacheBytes ?? 0,
        historyCount: history?.count ?? 0,
        lastVisitedAt: history?.lastVisitedAt,
      };
    }))
    .sort(compareTargets);
});

const siteOptions = computed(() => browser.sites.filter((site) =>
  cacheTargets.value.some((target) => target.site.id === site.id),
));

const displayedTargets = computed(() => {
  const keyword = searchText.value.trim().toLowerCase();
  return cacheTargets.value.filter((target) => {
    if (selectedSiteId.value && target.site.id !== selectedSiteId.value) {
      return false;
    }

    if (!keyword) {
      return true;
    }

    return [
      siteDisplayTitle(target.site),
      target.site.url,
      target.session.name,
      target.session.lastUrl,
    ].some((value) => value?.toLowerCase().includes(keyword));
  });
});

const groupedTargets = computed<SiteGroup[]>(() => {
  const groups = new Map<string, SiteGroup>();

  for (const target of displayedTargets.value) {
    const current = groups.get(target.site.id) ?? {
      site: target.site,
      cacheBytes: 0,
      historyCount: 0,
      lastVisitedAt: undefined,
      targets: [],
    };
    current.cacheBytes += target.cacheBytes;
    current.historyCount += target.historyCount;
    if (target.lastVisitedAt && (!current.lastVisitedAt || target.lastVisitedAt > current.lastVisitedAt)) {
      current.lastVisitedAt = target.lastVisitedAt;
    }
    current.targets.push(target);
    groups.set(target.site.id, current);
  }

  return [...groups.values()].sort((left, right) => {
    if (left.lastVisitedAt && right.lastVisitedAt && left.lastVisitedAt !== right.lastVisitedAt) {
      return right.lastVisitedAt.localeCompare(left.lastVisitedAt);
    }

    if (left.lastVisitedAt) {
      return -1;
    }

    if (right.lastVisitedAt) {
      return 1;
    }

    return siteDisplayTitle(left.site).localeCompare(siteDisplayTitle(right.site));
  });
});

const visibleTargetCount = computed(() => displayedTargets.value.length);
const totalCacheBytes = computed(() => displayedTargets.value.reduce((total, target) => total + target.cacheBytes, 0));
const totalSiteCount = computed(() => new Set(displayedTargets.value.map((target) => target.site.id)).size);
const totalHistoryCount = computed(() =>
  displayedTargets.value.reduce((total, target) => total + target.historyCount, 0),
);
const selectedCacheCount = computed(() => displayedTargets.value.filter((target) => target.cacheBytes > 0).length);
const canClear = computed(() => displayedTargets.value.length > 0);

onMounted(() => {
  void loadStats();
});

async function loadStats() {
  try {
    loading.value = true;
    const [stats, records] = await Promise.all([
      window.appApi.storage.stats(),
      window.appApi.history.list(),
    ]);
    storageStats.value = stats;
    historyRecords.value = records;
  } catch (error) {
    ElMessage.error(formatError(error));
  } finally {
    loading.value = false;
  }
}

async function clearBrowsingData() {
  if (!canClear.value || !window.confirm('清理当前筛选出的站点缓存？不会清理 Cookie、LocalStorage 或登录状态。')) {
    return;
  }

  try {
    clearing.value = true;
    const partitions = unique(displayedTargets.value.map((target) => target.partition));
    await Promise.all(partitions.map((partition) => window.appApi.storage.clearData({ partition })));

    await loadStats();
    ElMessage.success('站点缓存已清理');
  } catch (error) {
    ElMessage.error(formatError(error));
  } finally {
    clearing.value = false;
  }
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

function hourText(value?: string) {
  if (!value) {
    return '无历史访问';
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return '无历史访问';
  }

  date.setMinutes(0, 0, 0);
  const end = new Date(date.getTime() + 60 * 60 * 1000);
  const datePart = date.toLocaleDateString([], {
    month: 'short',
    day: 'numeric',
  });
  const startHour = date.toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  });
  const endHour = end.toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  });
  return `${datePart} ${startHour} - ${endHour}`;
}

function siteDisplayTitle(site: Site) {
  return site.title || new URL(site.url).hostname;
}

function siteHost(site: Site) {
  try {
    return new URL(site.url).hostname;
  } catch {
    return site.url;
  }
}

function compareTargets(left: CacheTarget, right: CacheTarget) {
  if (left.lastVisitedAt && right.lastVisitedAt && left.lastVisitedAt !== right.lastVisitedAt) {
    return right.lastVisitedAt.localeCompare(left.lastVisitedAt);
  }

  if (left.lastVisitedAt) {
    return -1;
  }

  if (right.lastVisitedAt) {
    return 1;
  }

  return siteDisplayTitle(left.site).localeCompare(siteDisplayTitle(right.site));
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
          <strong>清理站点缓存</strong>
        </span>
        <ElButton :loading="loading" @click="loadStats">
          <Refresh theme="outline" size="16" />
          刷新
        </ElButton>
      </header>

      <section class="clear-data-grid" aria-label="浏览数据清理">
        <aside class="clear-data-panel">
          <label class="clear-data-field">
            <span>站点</span>
            <ElSelect v-model="selectedSiteId" clearable filterable placeholder="全部站点">
              <ElOption
                v-for="site in siteOptions"
                :key="site.id"
                :label="siteDisplayTitle(site)"
                :value="site.id"
              />
            </ElSelect>
          </label>

          <label class="clear-data-field">
            <span>搜索</span>
            <ElInput v-model="searchText" clearable placeholder="搜索站点或会话">
              <template #prefix>
                <Search theme="outline" size="15" />
              </template>
            </ElInput>
          </label>

          <div class="clear-data-note">
            仅清理 HTTP 缓存，不会清理 Cookie、LocalStorage、IndexedDB 或历史记录。
          </div>

          <ElButton
            type="danger"
            :disabled="!canClear"
            :loading="clearing"
            @click="clearBrowsingData"
          >
            <Delete theme="outline" size="16" />
            清理缓存
          </ElButton>
        </aside>

        <section class="clear-data-content" aria-label="站点缓存统计">
          <div class="clear-data-summary">
            <span>
              <strong>{{ totalSiteCount }}</strong>
              站点
            </span>
            <span>
              <strong>{{ visibleTargetCount }}</strong>
              会话
            </span>
            <span>
              <strong>{{ selectedCacheCount }}</strong>
              有缓存
            </span>
            <span>
              <strong>{{ totalHistoryCount }}</strong>
              访问记录
            </span>
            <span>
              <strong>{{ sizeText(totalCacheBytes) }}</strong>
              缓存
            </span>
          </div>

          <p v-if="!groupedTargets.length" class="clear-data-empty">
            暂无可展示的站点缓存
          </p>

          <article
            v-for="group in groupedTargets"
            :key="group.site.id"
            class="site-cache-block"
          >
            <header>
              <span class="site-cache-block__title">
                <strong>{{ siteDisplayTitle(group.site) }}</strong>
                <small>{{ siteHost(group.site) }}</small>
              </span>
              <span>{{ group.targets.length }} 个会话 · {{ sizeText(group.cacheBytes) }} 缓存</span>
            </header>

            <div class="site-cache-list">
              <div
                v-for="target in group.targets"
                :key="target.partition"
                class="site-cache-row"
              >
                <span class="site-cache-row__main">
                  <strong>{{ target.session.name }}</strong>
                  <small>{{ hourText(target.lastVisitedAt) }}</small>
                </span>
                <span>{{ target.historyCount }} 次访问</span>
                <span>{{ sizeText(target.cacheBytes) }}</span>
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
.site-cache-block header,
.site-cache-row {
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
.site-cache-block {
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

.clear-data-note {
  border-radius: 8px;
  padding: 11px 12px;
  background: #f1f8f4;
  color: #1e5f3c;
  font-size: 12px;
  line-height: 1.6;
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

.site-cache-block {
  overflow: hidden;
}

.site-cache-block header {
  justify-content: space-between;
  gap: 14px;
  border-bottom: 1px solid #edf0f2;
  padding: 12px 14px;
}

.site-cache-block__title {
  display: grid;
  min-width: 0;
  gap: 3px;
}

.site-cache-block header strong,
.site-cache-block header small {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.site-cache-block header strong {
  color: #202124;
  font-size: 14px;
}

.site-cache-block header small {
  color: #7a8087;
  font-size: 11px;
}

.site-cache-block header > span:not(.site-cache-block__title) {
  flex: 0 0 auto;
  color: #5f6368;
  font-size: 12px;
}

.site-cache-list {
  display: grid;
}

.site-cache-row {
  min-width: 0;
  gap: 14px;
  padding: 11px 14px;
  color: #5f6368;
  font-size: 12px;
}

.site-cache-row + .site-cache-row {
  border-top: 1px solid #f1f3f4;
}

.site-cache-row__main {
  display: grid;
  min-width: 0;
  flex: 1 1 auto;
  gap: 3px;
}

.site-cache-row__main strong,
.site-cache-row__main small {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.site-cache-row__main strong {
  color: #202124;
  font-size: 13px;
}

.site-cache-row__main small {
  color: #7a8087;
  font-size: 11px;
}

.site-cache-row > span:not(.site-cache-row__main) {
  flex: 0 0 auto;
}
</style>
