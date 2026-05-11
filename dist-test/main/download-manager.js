"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DownloadManager = void 0;
const electron_1 = require("electron");
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
class DownloadManager {
    window;
    store;
    boundKeys = new Set();
    activeItems = new Map();
    constructor(window, store) {
        this.window = window;
        this.store = store;
    }
    bindDefault() {
        this.bindSession("default", electron_1.session.defaultSession);
    }
    pause(downloadId) {
        const item = this.requireActiveItem(downloadId);
        item.pause();
        return this.writeItem(downloadId, item, item.getState());
    }
    resume(downloadId) {
        const item = this.requireActiveItem(downloadId);
        item.resume();
        return this.writeItem(downloadId, item, item.getState());
    }
    cancel(downloadId) {
        const item = this.requireActiveItem(downloadId);
        item.cancel();
        return this.writeItem(downloadId, item, "cancelled");
    }
    async open(downloadId) {
        const download = this.requireStoredDownload(downloadId);
        const savePath = this.requireExistingSavePath(download);
        const errorMessage = await electron_1.shell.openPath(savePath);
        if (errorMessage) {
            throw new Error(errorMessage);
        }
    }
    async showInFolder(downloadId) {
        const download = this.requireStoredDownload(downloadId);
        const savePath = this.requireExistingSavePath(download);
        electron_1.shell.showItemInFolder(savePath);
        if (process.platform === "darwin") {
            return;
        }
        const errorMessage = await electron_1.shell.openPath((0, node_path_1.dirname)(savePath));
        if (errorMessage) {
            throw new Error(errorMessage);
        }
    }
    bindSession(key, targetSession) {
        if (this.boundKeys.has(key)) {
            return;
        }
        this.boundKeys.add(key);
        targetSession.on("will-download", (_event, item) => {
            const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
            const filename = (0, node_path_1.basename)(item.getFilename());
            const settings = this.store.getDownloadSettings();
            let plannedSavePath = "";
            const startedAt = Date.now();
            if (settings.askWhereToSaveBeforeDownloading) {
                item.setSaveDialogOptions({ defaultPath: (0, node_path_1.join)(settings.downloadPath, filename) });
            }
            else {
                try {
                    const savePath = createUniqueDownloadPath(settings.downloadPath, filename);
                    plannedSavePath = savePath;
                    item.setSavePath(savePath);
                }
                catch (error) {
                    void this.writeItem(id, item, "interrupted", formatError(error));
                    item.cancel();
                }
            }
            this.activeItems.set(id, item);
            void this.writeItem(id, item, "progressing", undefined, plannedSavePath, startedAt);
            item.on("updated", (_updatedEvent, state) => {
                void this.writeItem(id, item, state, undefined, "", startedAt);
            });
            item.once("done", (_doneEvent, state) => {
                this.activeItems.delete(id);
                void this.writeItem(id, item, state, undefined, "", startedAt);
            });
        });
    }
    requireActiveItem(downloadId) {
        const item = this.activeItems.get(downloadId);
        if (!item) {
            throw new Error("下载任务不可控制");
        }
        return item;
    }
    requireStoredDownload(downloadId) {
        const download = this.store.getDownload(downloadId);
        if (!download) {
            throw new Error("下载记录不存在");
        }
        return download;
    }
    requireExistingSavePath(download) {
        if (!download.savePath) {
            throw new Error("下载文件路径不存在");
        }
        if (!(0, node_fs_1.existsSync)(download.savePath)) {
            throw new Error(`文件不存在：${download.savePath}`);
        }
        return download.savePath;
    }
    async writeItem(id, item, state, errorText, fallbackSavePath = "", fallbackStartTime = Date.now()) {
        const savePath = item.getSavePath() || fallbackSavePath;
        const download = {
            id,
            filename: (0, node_path_1.basename)(savePath || item.getFilename()),
            url: item.getURL(),
            savePath,
            mimeType: item.getMimeType(),
            receivedBytes: item.getReceivedBytes(),
            totalBytes: item.getTotalBytes(),
            state,
            startTime: toMilliseconds(item.getStartTime()) || fallbackStartTime,
            endTime: state === "progressing" ? undefined : toMilliseconds(item.getEndTime()) || Date.now(),
            paused: item.isPaused(),
            canResume: item.canResume(),
            speedBytesPerSecond: item.getCurrentBytesPerSecond(),
            errorText,
        };
        const stored = await this.store.upsertDownload(download);
        if (!this.window.isDestroyed() && !this.window.webContents.isDestroyed()) {
            this.window.webContents.send("download:updated", stored);
        }
        return stored;
    }
}
exports.DownloadManager = DownloadManager;
function createUniqueDownloadPath(downloadPath, filename) {
    (0, node_fs_1.mkdirSync)(downloadPath, { recursive: true });
    const parsedExtension = (0, node_path_1.extname)(filename);
    const name = filename.slice(0, filename.length - parsedExtension.length);
    let candidate = (0, node_path_1.join)(downloadPath, filename);
    let index = 1;
    while ((0, node_fs_1.existsSync)(candidate)) {
        candidate = (0, node_path_1.join)(downloadPath, `${name} (${index})${parsedExtension}`);
        index += 1;
    }
    (0, node_fs_1.mkdirSync)((0, node_path_1.dirname)(candidate), { recursive: true });
    return candidate;
}
function toMilliseconds(seconds) {
    return seconds > 0 ? Math.round(seconds * 1000) : 0;
}
function formatError(error) {
    return error instanceof Error ? error.message : String(error);
}
