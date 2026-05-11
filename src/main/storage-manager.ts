import { session } from "electron";
import type {
  BrowserStorageType,
  StorageClearDataInput,
  StorageClearDataResult,
  StorageOriginStats,
  StoragePartitionStats,
  StorageStatsInput,
} from "../shared/types";
import type { HistoryManager } from "./history-manager";

type KnownPartitionProvider = () => string[];

const defaultStorages: BrowserStorageType[] = [
  "cookies",
  "filesystem",
  "indexdb",
  "localstorage",
  "shadercache",
  "websql",
  "serviceworkers",
  "cachestorage",
];

export class StorageManager {
  constructor(
    private readonly historyManager: HistoryManager,
    private readonly getKnownPartitions: KnownPartitionProvider,
  ) {}

  async stats(input: StorageStatsInput = {}) {
    const partitions = this.resolvePartitions(input);
    const stats = await Promise.all(partitions.map((partition) => this.getPartitionStats(partition, input.origin)));
    return stats.filter((item) => item.origins.length > 0 || !input.origin);
  }

  async clearData(input: StorageClearDataInput): Promise<StorageClearDataResult> {
    const partition = cleanPartition(input.partition);
    const targetSession = session.fromPartition(partition);
    const storages = input.storages ?? defaultStorages;
    const clearStorage = storages.length > 0;

    if (clearStorage) {
      await targetSession.clearStorageData({
        origin: input.origin,
        storages,
      });
    }

    if (input.clearCache) {
      await targetSession.clearCache();
    }

    return {
      partition,
      origin: input.origin,
      storagesCleared: clearStorage ? storages : [],
      cacheCleared: Boolean(input.clearCache),
    };
  }

  private resolvePartitions(input: StorageStatsInput) {
    if (input.partition) {
      return [cleanPartition(input.partition)];
    }

    return [...new Set([
      ...this.getKnownPartitions().map(cleanPartition),
      ...this.historyManager.list().map((record) => cleanPartition(record.partition)),
    ])].sort();
  }

  private async getPartitionStats(partition: string, originFilter?: string): Promise<StoragePartitionStats> {
    const targetSession = session.fromPartition(partition);
    const [cacheBytes, cookies] = await Promise.all([
      targetSession.getCacheSize().catch(() => 0),
      targetSession.cookies.get({}).catch(() => []),
    ]);
    const history = this.historyManager.list({ partition });
    const origins = new Map<string, StorageOriginStats>();

    for (const record of history) {
      if (originFilter && record.origin !== originFilter) {
        continue;
      }

      const stats = getOrCreateOriginStats(origins, record.origin);
      stats.historyCount += 1;
      if (!stats.lastVisitedAt || record.visitedAt > stats.lastVisitedAt) {
        stats.lastVisitedAt = record.visitedAt;
      }
    }

    for (const cookie of cookies) {
      const origin = inferCookieOrigin(cookie);
      if (!origin || (originFilter && origin !== originFilter)) {
        continue;
      }

      const stats = getOrCreateOriginStats(origins, origin);
      stats.cookieCount += 1;
      stats.cookieBytes += Buffer.byteLength(cookie.name) + Buffer.byteLength(cookie.value);
    }

    const originStats = [...origins.values()].sort(compareOriginStats);

    return {
      partition,
      cacheBytes,
      storagePath: targetSession.getStoragePath() ?? undefined,
      originCount: originStats.length,
      origins: originStats,
    };
  }
}

function getOrCreateOriginStats(origins: Map<string, StorageOriginStats>, origin: string) {
  const existing = origins.get(origin);
  if (existing) {
    return existing;
  }

  const stats: StorageOriginStats = {
    origin,
    historyCount: 0,
    cookieCount: 0,
    cookieBytes: 0,
  };
  origins.set(origin, stats);
  return stats;
}

function inferCookieOrigin(cookie: Electron.Cookie) {
  const domain = cookie.domain?.replace(/^\./, "");
  if (!domain) {
    return undefined;
  }

  const protocol = cookie.secure ? "https" : "http";
  return `${protocol}://${domain}`;
}

function compareOriginStats(left: StorageOriginStats, right: StorageOriginStats) {
  if (left.lastVisitedAt && right.lastVisitedAt && left.lastVisitedAt !== right.lastVisitedAt) {
    return right.lastVisitedAt.localeCompare(left.lastVisitedAt);
  }

  if (left.lastVisitedAt) {
    return -1;
  }

  if (right.lastVisitedAt) {
    return 1;
  }

  return left.origin.localeCompare(right.origin);
}

function cleanPartition(partition: string) {
  const trimmed = partition.trim();
  if (!trimmed) {
    throw new Error("partition 不能为空");
  }

  return trimmed;
}
