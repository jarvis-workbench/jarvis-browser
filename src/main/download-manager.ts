import { BrowserWindow, DownloadItem, Event, session } from "electron";
import { basename } from "node:path";
import type { DownloadState } from "../shared/types";
import type { MetadataStore } from "./store";

export class DownloadManager {
  private readonly boundKeys = new Set<string>();

  constructor(
    private readonly window: BrowserWindow,
    private readonly store: MetadataStore,
  ) {}

  bindDefault() {
    this.bindSession("default", session.defaultSession);
  }

  bindSession(key: string, targetSession: Electron.Session) {
    if (this.boundKeys.has(key)) {
      return;
    }

    this.boundKeys.add(key);
    targetSession.on("will-download", (_event: Event, item: DownloadItem) => {
      const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

      const write = (state: DownloadState["state"]) => {
        const download = {
          id,
          filename: basename(item.getFilename()),
          receivedBytes: item.getReceivedBytes(),
          totalBytes: item.getTotalBytes(),
          state,
        } satisfies DownloadState;
        void this.store.upsertDownload(download);

        if (!this.window.isDestroyed() && !this.window.webContents.isDestroyed()) {
          this.window.webContents.send("download:updated", download);
        }
      };

      write("progressing");
      item.on("updated", () => write("progressing"));
      item.once("done", (_doneEvent, state) => write(state));
    });
  }
}
