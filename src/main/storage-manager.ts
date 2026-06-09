import { session } from "electron";
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
    await targetSession.clearCache();

    return {
      partition,
      cacheCleared: true,
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
    const cacheBytes = await targetSession.getCacheSize().catch(() => 0);

    return {
      partition,
      cacheBytes,
      storagePath: targetSession.getStoragePath() ?? undefined,
    };
  }
}

function cleanPartition(partition: string) {
  const trimmed = partition.trim();
  if (!trimmed) {
    throw new Error("partition 不能为空");
  }

  return trimmed;
}
