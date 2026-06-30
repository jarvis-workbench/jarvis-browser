import { session } from "electron";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type {
  StorageClearDataInput,
  StorageClearDataResult,
  StoragePartitionStats,
  StorageStatsInput,
} from "../shared/types";
import type { HistoryManager } from "./history-manager";

type KnownPartitionProvider = () => string[];

export class StorageManager {
  constructor(
    private readonly historyManager: HistoryManager,
    private readonly getKnownPartitions: KnownPartitionProvider,
  ) {}

  async stats(input: StorageStatsInput = {}) {
    const partitions = this.resolvePartitions(input);
    return Promise.all(partitions.map((partition) => this.getPartitionStats(partition)));
  }

  async clearData(input: StorageClearDataInput): Promise<StorageClearDataResult> {
    const partition = cleanPartition(input.partition);
    const targetSession = session.fromPartition(partition);
    await Promise.all([
      targetSession.clearCache(),
      targetSession.clearStorageData({ storages: ["cachestorage"] }),
    ]);

    return {
      partition,
      cacheCleared: true,
      serviceWorkerCacheCleared: true,
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

  private async getPartitionStats(partition: string): Promise<StoragePartitionStats> {
    const targetSession = session.fromPartition(partition);
    const storagePath = targetSession.getStoragePath() ?? undefined;
    const [httpCacheBytes, serviceWorkerCacheBytes] = await Promise.all([
      targetSession.getCacheSize().catch(() => 0),
      storagePath ? directorySize(join(storagePath, "Service Worker", "CacheStorage")) : Promise.resolve(0),
    ]);

    return {
      partition,
      cacheBytes: httpCacheBytes + serviceWorkerCacheBytes,
      httpCacheBytes,
      serviceWorkerCacheBytes,
      storagePath,
    };
  }
}

async function directorySize(path: string): Promise<number> {
  let total = 0;
  const entries = await readdir(path, { withFileTypes: true }).catch(() => []);

  await Promise.all(entries.map(async (entry) => {
    const entryPath = join(path, entry.name);
    if (entry.isDirectory()) {
      total += await directorySize(entryPath);
      return;
    }

    if (!entry.isFile()) {
      return;
    }

    const stats = await stat(entryPath).catch(() => undefined);
    total += stats?.size ?? 0;
  }));

  return total;
}

function cleanPartition(partition: string) {
  const trimmed = partition.trim();
  if (!trimmed) {
    throw new Error("partition 不能为空");
  }

  return trimmed;
}
