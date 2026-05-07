import { contextBridge, ipcRenderer } from "electron";
import type { AppApi, CookieRemoveDetails, CookieSetDetails } from "../shared/types";

const extensionPopup: AppApi["extensionPopup"] = {
  cookiesSet: (details: CookieSetDetails) =>
    ipcRenderer.invoke("extension-popup:cookies-set", details) as Promise<void>,
  cookiesRemove: (details: CookieRemoveDetails) =>
    ipcRenderer.invoke("extension-popup:cookies-remove", details) as Promise<void>,
};

contextBridge.exposeInMainWorld("jarvisExtensionPopup", extensionPopup);
