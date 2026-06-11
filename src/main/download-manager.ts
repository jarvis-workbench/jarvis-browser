import { BrowserWindow, DownloadItem, Event, session, shell } from "electron";
import { existsSync, mkdirSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import type { DownloadState } from "../shared/types";
import type { MetadataStore } from "./store";
import { createId, formatError } from "../shared/utils";

type PendingDownloadWrite = {
  item: DownloadItem;
  state: DownloadState["state"];
  errorText?: string;
  fallbackSavePath: string;
  fallbackStartTime: number;
};

type ManagedDownload = {
  id: string;
  item: DownloadItem;
  plannedSavePath: string;
  startedAt: number;
  queueState: "queued" | "active" | "done";
};

const maxConcurrentDownloads = 2;

export class DownloadManager {
  private readonly boundSessions = new WeakSet<Electron.Session>();
  private readonly managedDownloads = new Map<string, ManagedDownload>();
  private readonly activeItems = new Map<string, DownloadItem>();
  private readonly queuedIds: string[] = [];
  private readonly pendingWrites = new Map<string, PendingDownloadWrite>();
  private readonly writeTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    private readonly window: BrowserWindow,
    private readonly store: MetadataStore,
    private readonly emitToInternalPages?: (download: DownloadState) => void,
  ) {}

  bindDefault() {
    this.bindSession("default", session.defaultSession);
  }

  pause(downloadId: string) {
    const item = this.requireControllableItem(downloadId);
    item.pause();
    return this.writeManagedItem(downloadId, "progressing");
  }

  resume(downloadId: string) {
    const managed = this.requireManagedDownload(downloadId);
    if (managed.queueState === "queued") {
      this.removeQueuedId(downloadId);
      this.startManagedDownload(managed);
      return this.writeManagedItem(downloadId, "progressing");
    }

    managed.item.resume();
    return this.writeManagedItem(downloadId, "progressing");
  }

  cancel(downloadId: string) {
    const managed = this.requireManagedDownload(downloadId);
    if (managed.queueState === "queued") {
      managed.queueState = "done";
      this.removeQueuedId(downloadId);
      this.managedDownloads.delete(downloadId);
      managed.item.cancel();
      void this.drainQueue();
      return this.writeDownloadState(this.createDownloadState(downloadId, managed.item, "cancelled", undefined, managed.plannedSavePath, managed.startedAt));
    }

    managed.item.cancel();
    return this.writeManagedItem(downloadId, "cancelled");
  }

  async open(downloadId: string) {
    const download = this.requireStoredDownload(downloadId);
    const savePath = this.requireExistingSavePath(download);

    const errorMessage = await shell.openPath(savePath);
    if (errorMessage) {
      throw new Error(errorMessage);
    }
  }

  async showInFolder(downloadId: string) {
    const download = this.requireStoredDownload(downloadId);
    const savePath = this.requireExistingSavePath(download);

    shell.showItemInFolder(savePath);
    if (process.platform === "darwin") {
      return;
    }

    const errorMessage = await shell.openPath(dirname(savePath));
    if (errorMessage) {
      throw new Error(errorMessage);
    }
  }

  bindSession(key: string, targetSession: Electron.Session) {
    if (this.boundSessions.has(targetSession)) {
      return;
    }

    this.boundSessions.add(targetSession);
    targetSession.on("will-download", (_event: Event, item: DownloadItem) => {
      const id = createId();
      const filename = basename(item.getFilename());
      const settings = this.store.getDownloadSettings();
      let plannedSavePath = "";
      const startedAt = Date.now();

      if (settings.askWhereToSaveBeforeDownloading) {
        item.setSaveDialogOptions({ defaultPath: join(settings.downloadPath, filename) });
      } else {
        try {
          const savePath = createUniqueDownloadPath(settings.downloadPath, filename);
          plannedSavePath = savePath;
          item.setSavePath(savePath);
        } catch (error) {
          void this.writeItem(id, item, "interrupted", formatError(error));
          item.cancel();
          return;
        }
      }

      const managed: ManagedDownload = {
        id,
        item,
        plannedSavePath,
        startedAt,
        queueState: "queued",
      };
      this.managedDownloads.set(id, managed);

      const canQueue = !settings.askWhereToSaveBeforeDownloading && isQueueableDownloadUrl(item.getURL());
      const shouldQueue = canQueue && this.activeItems.size >= maxConcurrentDownloads;
      if (shouldQueue) {
        item.pause();
        this.queuedIds.push(id);
        void this.writeManagedItem(id, "queued");
      } else {
        this.startManagedDownload(managed);
        void this.writeManagedItem(id, "progressing");
      }

      item.on("updated", (_updatedEvent, state) => {
        if (managed.queueState === "queued") {
          return;
        }

        this.scheduleItemWrite(id, item, state, undefined, plannedSavePath, startedAt);
      });
      item.once("done", (_doneEvent, state) => {
        managed.queueState = "done";
        this.activeItems.delete(id);
        this.managedDownloads.delete(id);
        this.removeQueuedId(id);
        this.clearScheduledWrite(id);
        void this.writeItem(id, item, state, undefined, plannedSavePath, startedAt);
        void this.drainQueue();
      });
    });
  }

  private scheduleItemWrite(
    id: string,
    item: DownloadItem,
    state: DownloadState["state"],
    errorText?: string,
    fallbackSavePath = "",
    fallbackStartTime = Date.now(),
  ) {
    this.pendingWrites.set(id, {
      item,
      state,
      errorText,
      fallbackSavePath,
      fallbackStartTime,
    });
    if (this.writeTimers.has(id)) {
      return;
    }

    const timer = setTimeout(() => {
      this.writeTimers.delete(id);
      const pending = this.pendingWrites.get(id);
      if (!pending) {
        return;
      }

      this.pendingWrites.delete(id);
      void this.writeItem(
        id,
        pending.item,
        pending.state,
        pending.errorText,
        pending.fallbackSavePath,
        pending.fallbackStartTime,
      );
    }, 300);
    this.writeTimers.set(id, timer);
  }

  private clearScheduledWrite(id: string) {
    const timer = this.writeTimers.get(id);
    if (timer) {
      clearTimeout(timer);
      this.writeTimers.delete(id);
    }
    this.pendingWrites.delete(id);
  }

  private requireControllableItem(downloadId: string) {
    const managed = this.managedDownloads.get(downloadId);
    if (!managed || managed.queueState === "done") {
      throw new Error("下载任务不可控制");
    }

    return managed.item;
  }

  private requireManagedDownload(downloadId: string) {
    const managed = this.managedDownloads.get(downloadId);
    if (!managed || managed.queueState === "done") {
      throw new Error("下载任务不可控制");
    }

    return managed;
  }

  private requireStoredDownload(downloadId: string) {
    const download = this.store.getDownload(downloadId);
    if (!download) {
      throw new Error("下载记录不存在");
    }

    return download;
  }

  private requireExistingSavePath(download: DownloadState) {
    if (!download.savePath) {
      throw new Error("下载文件路径不存在");
    }

    if (!existsSync(download.savePath)) {
      throw new Error(`文件不存在：${download.savePath}`);
    }

    return download.savePath;
  }

  private async writeItem(
    id: string,
    item: DownloadItem,
    state: DownloadState["state"],
    errorText?: string,
    fallbackSavePath = "",
    fallbackStartTime = Date.now(),
  ) {
    const download = this.createDownloadState(id, item, state, errorText, fallbackSavePath, fallbackStartTime);
    return this.writeDownloadState(download);
  }

  private writeManagedItem(id: string, state: DownloadState["state"], errorText?: string) {
    const managed = this.requireManagedDownload(id);
    return this.writeItem(id, managed.item, state, errorText, managed.plannedSavePath, managed.startedAt);
  }

  private async writeDownloadState(download: DownloadState) {
    const stored = await this.store.upsertDownload(download);
    this.emitDownloadUpdate(stored);

    return stored;
  }

  private createDownloadState(
    id: string,
    item: DownloadItem,
    state: DownloadState["state"],
    errorText?: string,
    fallbackSavePath = "",
    fallbackStartTime = Date.now(),
  ) {
    const savePath = item.getSavePath() || fallbackSavePath;
    return {
      id,
      filename: basename(savePath || item.getFilename()),
      url: item.getURL(),
      savePath,
      mimeType: item.getMimeType(),
      receivedBytes: item.getReceivedBytes(),
      totalBytes: item.getTotalBytes(),
      state,
      startTime: toMilliseconds(item.getStartTime()) || fallbackStartTime,
      endTime: state === "progressing" || state === "queued" ? undefined : toMilliseconds(item.getEndTime()) || Date.now(),
      paused: item.isPaused(),
      canResume: item.canResume(),
      speedBytesPerSecond: item.getCurrentBytesPerSecond(),
      errorText,
    } satisfies DownloadState;
  }

  private emitDownloadUpdate(download: DownloadState) {
    if (!this.window.isDestroyed() && !this.window.webContents.isDestroyed()) {
      this.window.webContents.send("download:updated", download);
    }
    this.emitToInternalPages?.(download);
  }

  private startManagedDownload(managed: ManagedDownload) {
    managed.queueState = "active";
    this.activeItems.set(managed.id, managed.item);
    if (managed.item.isPaused()) {
      managed.item.resume();
    }
  }

  private drainQueue() {
    while (this.activeItems.size < maxConcurrentDownloads) {
      const id = this.queuedIds.shift();
      if (!id) {
        return;
      }

      const managed = this.managedDownloads.get(id);
      if (!managed || managed.queueState !== "queued") {
        continue;
      }

      this.startManagedDownload(managed);
      void this.writeManagedItem(id, "progressing");
    }
  }

  private removeQueuedId(downloadId: string) {
    const index = this.queuedIds.indexOf(downloadId);
    if (index >= 0) {
      this.queuedIds.splice(index, 1);
    }
  }
}

function createUniqueDownloadPath(downloadPath: string, filename: string) {
  mkdirSync(downloadPath, { recursive: true });
  const parsedExtension = extname(filename);
  const name = filename.slice(0, filename.length - parsedExtension.length);
  let candidate = join(downloadPath, filename);
  let index = 1;

  while (existsSync(candidate)) {
    candidate = join(downloadPath, `${name} (${index})${parsedExtension}`);
    index += 1;
  }

  mkdirSync(dirname(candidate), { recursive: true });
  return candidate;
}

function isQueueableDownloadUrl(url: string) {
  try {
    const protocol = new URL(url).protocol;
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

function toMilliseconds(seconds: number) {
  return seconds > 0 ? Math.round(seconds * 1000) : 0;
}
