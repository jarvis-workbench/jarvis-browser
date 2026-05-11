import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { HistoryClearInput, HistoryListInput, HistoryRecord } from "../shared/types";
import { dataPaths } from "./data-paths";

type HistoryFile = {
  version: 1;
  records: HistoryRecord[];
};

type NavigationInput = {
  tabId?: string;
  siteId?: string;
  sessionId?: string;
  partition: string;
  url: string;
  title?: string;
};

const historyFilePath = join(dataPaths.global.root, "history.json");
const maxHistoryRecords = 5000;

const now = () => new Date().toISOString();

const createId = () => {
  if (globalThis.crypto?.randomUUID) {
    return globalThis.crypto.randomUUID();
  }

  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
};

export class HistoryManager {
  private records: HistoryRecord[] = [];
  private loaded = false;
  private writeQueue = Promise.resolve();

  async load() {
    if (this.loaded) {
      return;
    }

    this.records = await readHistoryFile();
    await writeHistoryFile(this.records);
    this.loaded = true;
  }

  list(input: HistoryListInput = {}) {
    this.assertLoaded();
    return this.records
      .filter((record) => matchesHistoryFilter(record, input))
      .slice(0, input.limit ?? this.records.length)
      .map((record) => structuredClone(record));
  }

  async recordNavigation(input: NavigationInput) {
    this.assertLoaded();

    const parsed = parseHttpOrigin(input.url);
    if (!parsed) {
      return undefined;
    }

    const timestamp = now();
    const record: HistoryRecord = {
      id: createId(),
      tabId: input.tabId,
      siteId: input.siteId,
      sessionId: input.sessionId,
      partition: input.partition,
      origin: parsed.origin,
      url: parsed.url,
      title: input.title?.trim() || undefined,
      visitedAt: timestamp,
      createdAt: timestamp,
    };

    this.records = [record, ...this.records].slice(0, maxHistoryRecords);
    await this.persist();
    return structuredClone(record);
  }

  async clear(input: HistoryClearInput = {}) {
    this.assertLoaded();
    const nextRecords = this.records.filter((record) => !matchesHistoryFilter(record, input));
    if (nextRecords.length === this.records.length) {
      return;
    }

    this.records = nextRecords;
    await this.persist();
  }

  private async persist() {
    this.writeQueue = this.writeQueue.then(() => writeHistoryFile(this.records));
    await this.writeQueue;
  }

  private assertLoaded() {
    if (!this.loaded) {
      throw new Error("历史服务尚未加载");
    }
  }
}

function matchesHistoryFilter(record: HistoryRecord, input: HistoryListInput | HistoryClearInput) {
  return (!input.partition || record.partition === input.partition)
    && (!input.origin || record.origin === input.origin)
    && (!input.siteId || record.siteId === input.siteId)
    && (!input.sessionId || record.sessionId === input.sessionId);
}

function parseHttpOrigin(url: string) {
  try {
    const parsed = new URL(url);
    if (!["http:", "https:"].includes(parsed.protocol)) {
      return undefined;
    }

    return {
      origin: parsed.origin,
      url: parsed.toString(),
    };
  } catch {
    return undefined;
  }
}

async function readHistoryFile(): Promise<HistoryRecord[]> {
  try {
    const parsed = JSON.parse(await readFile(historyFilePath, "utf8")) as Partial<HistoryFile> | HistoryRecord[];
    const records = Array.isArray(parsed) ? parsed : parsed.records;
    if (!Array.isArray(records)) {
      return [];
    }

    return records
      .map(normalizeHistoryRecord)
      .filter((record): record is HistoryRecord => Boolean(record))
      .slice(0, maxHistoryRecords);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }

    throw error;
  }
}

async function writeHistoryFile(records: HistoryRecord[]) {
  await mkdir(dirname(historyFilePath), { recursive: true });
  const value: HistoryFile = {
    version: 1,
    records,
  };
  await writeFile(historyFilePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function normalizeHistoryRecord(input: Partial<HistoryRecord>): HistoryRecord | undefined {
  if (!input.id || !input.partition || !input.origin || !input.url || !input.visitedAt || !input.createdAt) {
    return undefined;
  }

  return {
    id: input.id,
    tabId: input.tabId,
    siteId: input.siteId,
    sessionId: input.sessionId,
    partition: input.partition,
    origin: input.origin,
    url: input.url,
    title: input.title,
    visitedAt: input.visitedAt,
    createdAt: input.createdAt,
  } satisfies HistoryRecord;
}
