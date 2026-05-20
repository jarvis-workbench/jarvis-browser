import { BrowserWindow, DownloadItem, Event, session, shell } from "electron";
import { existsSync, mkdirSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import type { DownloadState } from "../shared/types";
import type { MetadataStore } from "./store";

type PendingDownloadWrite = {
  item: DownloadItem;
  state: DownloadState["state"];
  errorText?: string;
  fallbackSavePath: string;
  fallbackStartTime: number;
};

export class DownloadManager {
  private readonly boundSessions = new WeakSet<Electron.Session>();
  private readonly activeItems = new Map<string, DownloadItem>();
  private readonly pendingWrites = new Map<string, PendingDownloadWrite>();
  private readonly writeTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    private readonly window: BrowserWindow,
    private readonly store: MetadataStore,
  ) {}

  bindDefault() {
    this.bindSession("default", session.defaultSession);
  }

  pause(downloadId: string) {
    const item = this.requireActiveItem(downloadId);
    item.pause();
    return this.writeItem(downloadId, item, item.getState());
  }

  resume(downloadId: string) {
    const item = this.requireActiveItem(downloadId);
    item.resume();
    return this.writeItem(downloadId, item, item.getState());
  }

  cancel(downloadId: string) {
    const item = this.requireActiveItem(downloadId);
    item.cancel();
    return this.writeItem(downloadId, item, "cancelled");
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
      const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
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

      this.activeItems.set(id, item);
      void this.writeItem(id, item, "progressing", undefined, plannedSavePath, startedAt);
      item.on("updated", (_updatedEvent, state) => {
        this.scheduleItemWrite(id, item, state, undefined, "", startedAt);
      });
      item.once("done", (_doneEvent, state) => {
        this.activeItems.delete(id);
        this.clearScheduledWrite(id);
        void this.writeItem(id, item, state, undefined, "", startedAt);
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

  private requireActiveItem(downloadId: string) {
    const item = this.activeItems.get(downloadId);
    if (!item) {
      throw new Error("下载任务不可控制");
    }

    return item;
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
    const savePath = item.getSavePath() || fallbackSavePath;
    const download = {
      id,
      filename: basename(savePath || item.getFilename()),
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
    } satisfies DownloadState;

    const stored = await this.store.upsertDownload(download);
    if (!this.window.isDestroyed() && !this.window.webContents.isDestroyed()) {
      this.window.webContents.send("download:updated", stored);
    }

    return stored;
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

function toMilliseconds(seconds: number) {
  return seconds > 0 ? Math.round(seconds * 1000) : 0;
}

function formatError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
