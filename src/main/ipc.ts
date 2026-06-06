import { BrowserHost } from "./browser-host";
import { HistoryManager } from "./history-manager";
import { IpcRouter } from "./ipc-router";
import { StorageManager } from "./storage-manager";
import { MetadataStore } from "./store";
import { UpdateManager } from "./update-manager";

export const registerIpc = (
  store: MetadataStore,
  browserHost: BrowserHost,
  historyManager: HistoryManager,
  storageManager: StorageManager,
  updateManager: UpdateManager,
) => {
  const ipcRouter = new IpcRouter(
    store,
    browserHost,
    historyManager,
    storageManager,
    updateManager,
  );
  ipcRouter.register();
};
