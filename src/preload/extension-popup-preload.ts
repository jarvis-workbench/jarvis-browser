import { contextBridge, ipcRenderer } from "electron";
import type { AppApi, CookieRemoveDetails, CookieSetDetails } from "../shared/types";

const params = new URLSearchParams(window.location.search);
const jarvisTarget = {
  siteId: params.get("jarvisSiteId") ?? undefined,
  sessionId: params.get("jarvisSessionId") ?? undefined,
};

const withJarvisTarget = <T extends CookieSetDetails | CookieRemoveDetails>(details: T): T => ({
  ...details,
  siteId: details.siteId ?? jarvisTarget.siteId,
  sessionId: details.sessionId ?? jarvisTarget.sessionId,
});

const extensionPopup: AppApi["extensionPopup"] = {
  cookiesSet: (details: CookieSetDetails) =>
    ipcRenderer.invoke("extension-popup:cookies-set", withJarvisTarget(details)) as Promise<void>,
  cookiesRemove: (details: CookieRemoveDetails) =>
    ipcRenderer.invoke("extension-popup:cookies-remove", withJarvisTarget(details)) as Promise<void>,
};

contextBridge.exposeInMainWorld("jarvisExtensionPopup", extensionPopup);
