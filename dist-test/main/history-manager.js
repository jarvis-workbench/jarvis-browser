"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.HistoryManager = void 0;
const promises_1 = require("node:fs/promises");
const node_path_1 = require("node:path");
const data_paths_1 = require("./data-paths");
const historyFilePath = (0, node_path_1.join)(data_paths_1.dataPaths.global.root, "history.json");
const maxHistoryRecords = 5000;
const now = () => new Date().toISOString();
const createId = () => {
    if (globalThis.crypto?.randomUUID) {
        return globalThis.crypto.randomUUID();
    }
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
};
class HistoryManager {
    records = [];
    loaded = false;
    writeQueue = Promise.resolve();
    async load() {
        if (this.loaded) {
            return;
        }
        this.records = await readHistoryFile();
        await writeHistoryFile(this.records);
        this.loaded = true;
    }
    list(input = {}) {
        this.assertLoaded();
        return this.records
            .filter((record) => matchesHistoryFilter(record, input))
            .slice(0, input.limit ?? this.records.length)
            .map((record) => structuredClone(record));
    }
    async recordNavigation(input) {
        this.assertLoaded();
        const parsed = parseHttpOrigin(input.url);
        if (!parsed) {
            return undefined;
        }
        const timestamp = now();
        const record = {
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
    async clear(input = {}) {
        this.assertLoaded();
        const nextRecords = this.records.filter((record) => !matchesHistoryFilter(record, input));
        if (nextRecords.length === this.records.length) {
            return;
        }
        this.records = nextRecords;
        await this.persist();
    }
    async persist() {
        this.writeQueue = this.writeQueue.then(() => writeHistoryFile(this.records));
        await this.writeQueue;
    }
    assertLoaded() {
        if (!this.loaded) {
            throw new Error("历史服务尚未加载");
        }
    }
}
exports.HistoryManager = HistoryManager;
function matchesHistoryFilter(record, input) {
    return (!input.partition || record.partition === input.partition)
        && (!input.origin || record.origin === input.origin)
        && (!input.siteId || record.siteId === input.siteId)
        && (!input.sessionId || record.sessionId === input.sessionId);
}
function parseHttpOrigin(url) {
    try {
        const parsed = new URL(url);
        if (!["http:", "https:"].includes(parsed.protocol)) {
            return undefined;
        }
        return {
            origin: parsed.origin,
            url: parsed.toString(),
        };
    }
    catch {
        return undefined;
    }
}
async function readHistoryFile() {
    try {
        const parsed = JSON.parse(await (0, promises_1.readFile)(historyFilePath, "utf8"));
        const records = Array.isArray(parsed) ? parsed : parsed.records;
        if (!Array.isArray(records)) {
            return [];
        }
        return records
            .map(normalizeHistoryRecord)
            .filter((record) => Boolean(record))
            .slice(0, maxHistoryRecords);
    }
    catch (error) {
        if (error.code === "ENOENT") {
            return [];
        }
        throw error;
    }
}
async function writeHistoryFile(records) {
    await (0, promises_1.mkdir)((0, node_path_1.dirname)(historyFilePath), { recursive: true });
    const value = {
        version: 1,
        records,
    };
    await (0, promises_1.writeFile)(historyFilePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
function normalizeHistoryRecord(input) {
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
    };
}
