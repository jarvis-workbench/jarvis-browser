import { app, BrowserWindow } from "electron";
import { autoUpdater, type ProgressInfo, type UpdateInfo } from "electron-updater";
import type { AppUpdateProgress, AppUpdateStatus } from "../shared/types";
import { formatError } from "../shared/utils";

const SUPPORTED_PLATFORMS = new Set<NodeJS.Platform>(["darwin", "win32"]);

export class UpdateManager {
  private status: AppUpdateStatus;
  private isChecking = false;
  private isDownloading = false;

  constructor(private readonly window: BrowserWindow) {
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = false;

    this.status = this.createInitialStatus();
    this.bindUpdaterEvents();
  }

  getStatus() {
    return this.status;
  }

  async checkForUpdates() {
    if (!this.canUseUpdater()) {
      this.setStatus({
        phase: "unsupported",
        errorText: app.isPackaged ? "当前平台暂不支持自动更新" : "开发模式无法执行真实更新",
      });
      return this.status;
    }

    if (this.isChecking || this.status.phase === "downloading" || this.status.phase === "installing") {
      return this.status;
    }

    this.isChecking = true;
    this.setStatus({
      phase: "checking",
      errorText: undefined,
      progress: undefined,
    });

    try {
      await autoUpdater.checkForUpdates();
    } catch (error) {
      this.setStatus({
        phase: "error",
        errorText: formatError(error),
      });
    } finally {
      this.isChecking = false;
    }

    return this.status;
  }

  async downloadUpdate() {
    if (!this.canUseUpdater()) {
      this.setStatus({
        phase: "unsupported",
        errorText: app.isPackaged ? "当前平台暂不支持自动更新" : "开发模式无法执行真实更新",
      });
      return this.status;
    }

    if (this.isDownloading || this.status.phase === "downloading" || this.status.phase === "downloaded") {
      return this.status;
    }

    if (this.status.phase !== "available") {
      throw new Error("暂无可下载的更新");
    }

    this.isDownloading = true;
    this.setStatus({
      phase: "downloading",
      errorText: undefined,
      progress: {
        percent: 0,
        transferred: 0,
        total: 0,
        bytesPerSecond: 0,
      },
    });

    try {
      await autoUpdater.downloadUpdate();
    } catch (error) {
      this.setStatus({
        phase: "error",
        errorText: formatError(error),
      });
    } finally {
      this.isDownloading = false;
    }

    return this.status;
  }

  quitAndInstall() {
    if (this.status.phase !== "downloaded") {
      throw new Error("更新尚未下载完成");
    }

    this.setStatus({ phase: "installing", errorText: undefined });
    autoUpdater.quitAndInstall(false, true);
    return this.status;
  }

  private createInitialStatus(): AppUpdateStatus {
    return {
      phase: this.canUseUpdater() ? "idle" : "unsupported",
      currentVersion: app.getVersion(),
      isPackaged: app.isPackaged,
      platform: process.platform,
      updatedAt: new Date().toISOString(),
      errorText: this.canUseUpdater()
        ? undefined
        : app.isPackaged
          ? "当前平台暂不支持自动更新"
          : "开发模式无法执行真实更新",
    };
  }

  private canUseUpdater() {
    return app.isPackaged && SUPPORTED_PLATFORMS.has(process.platform);
  }

  private bindUpdaterEvents() {
    autoUpdater.on("update-available", (info) => {
      this.isChecking = false;
      this.setStatus({
        ...this.infoToStatus(info),
        phase: "available",
        errorText: undefined,
      });
    });

    autoUpdater.on("update-not-available", (info) => {
      this.isChecking = false;
      this.setStatus({
        ...this.infoToStatus(info),
        phase: "not-available",
        errorText: undefined,
        progress: undefined,
      });
    });

    autoUpdater.on("download-progress", (progress) => {
      this.setStatus({
        phase: "downloading",
        progress: normalizeProgress(progress),
        errorText: undefined,
      });
    });

    autoUpdater.on("update-downloaded", (info) => {
      this.isDownloading = false;
      this.setStatus({
        ...this.infoToStatus(info),
        phase: "downloaded",
        progress: {
          percent: 100,
          transferred: 0,
          total: 0,
          bytesPerSecond: 0,
        },
        errorText: undefined,
      });
    });

    autoUpdater.on("error", (error) => {
      this.isChecking = false;
      this.isDownloading = false;
      this.setStatus({
        phase: "error",
        errorText: formatError(error),
      });
    });
  }

  private infoToStatus(info?: UpdateInfo): Partial<AppUpdateStatus> {
    if (!info) {
      return {};
    }

    return {
      availableVersion: info.version,
      releaseDate: info.releaseDate,
      releaseName: info.releaseName ?? undefined,
      releaseNotes: normalizeReleaseNotes(info.releaseNotes),
    };
  }

  private setStatus(patch: Partial<AppUpdateStatus>) {
    this.status = {
      ...this.status,
      ...patch,
      currentVersion: app.getVersion(),
      isPackaged: app.isPackaged,
      platform: process.platform,
      updatedAt: new Date().toISOString(),
    };
    this.window.webContents.send("updates:status-changed", this.status);
  }
}

function normalizeProgress(progress: ProgressInfo): AppUpdateProgress {
  return {
    percent: Number.isFinite(progress.percent) ? Math.max(0, Math.min(100, progress.percent)) : 0,
    transferred: progress.transferred || 0,
    total: progress.total || 0,
    bytesPerSecond: progress.bytesPerSecond || 0,
  };
}

function normalizeReleaseNotes(releaseNotes: UpdateInfo["releaseNotes"]) {
  if (typeof releaseNotes === "string") {
    return releaseNotes;
  }

  if (Array.isArray(releaseNotes)) {
    return releaseNotes
      .map((note) => {
        if (typeof note === "string") {
          return note;
        }

        return [note.version, note.note].filter(Boolean).join("\n");
      })
      .filter(Boolean)
      .join("\n\n");
  }

  return undefined;
}


