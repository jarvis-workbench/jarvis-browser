import { contextBridge, ipcRenderer } from "electron";

import type { BrowserRect } from "../shared/types";

type OverlayAction = {
  action: string;
  id: string;
  anchor?: BrowserRect;
};

const overlayApi = {
  onData(callback: (data: unknown) => void) {
    const listener = (_event: Electron.IpcRendererEvent, data: unknown) => callback(data);
    ipcRenderer.on("overlay:data", listener);
    return () => ipcRenderer.removeListener("overlay:data", listener);
  },
  action(input: OverlayAction) {
    return ipcRenderer.invoke("overlays:action", input) as Promise<void>;
  },
  close() {
    return ipcRenderer.invoke("overlays:close") as Promise<void>;
  },
};

contextBridge.exposeInMainWorld("jarvisOverlay", overlayApi);
