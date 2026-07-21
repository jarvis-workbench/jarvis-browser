import { contextBridge, ipcRenderer } from "electron";
import type {
  AppApi,
  BrowserTab,
  CookieGetDetails,
  CookieInfo,
  CookieRemoveDetails,
  CookieSetDetails,
} from "../shared/types";

const params = new URLSearchParams(window.location.search);
const jarvisTarget = {
  siteId: params.get("jarvisSiteId") ?? undefined,
  sessionId: params.get("jarvisSessionId") ?? undefined,
  browserTabId: params.get("jarvisBrowserTabId") ?? undefined,
};

const withJarvisTarget = <T extends CookieSetDetails | CookieRemoveDetails | CookieGetDetails>(details: T): T => ({
  ...details,
  siteId: details.siteId ?? jarvisTarget.siteId,
  sessionId: details.sessionId ?? jarvisTarget.sessionId,
});

const extensionPopup: AppApi["extensionPopup"] = {
  cookiesGet: (details: CookieGetDetails) =>
    ipcRenderer.invoke("extension-popup:cookies-get", withJarvisTarget(details)) as Promise<CookieInfo[]>,
  cookiesSet: (details: CookieSetDetails) =>
    ipcRenderer.invoke("extension-popup:cookies-set", withJarvisTarget(details)) as Promise<void>,
  cookiesRemove: (details: CookieRemoveDetails) =>
    ipcRenderer.invoke("extension-popup:cookies-remove", withJarvisTarget(details)) as Promise<void>,
  createTab: (input) =>
    ipcRenderer.invoke("extension-popup:create-tab", {
      ...input,
      siteId: input.siteId ?? jarvisTarget.siteId,
      sessionId: input.sessionId ?? jarvisTarget.sessionId,
      openerTabId: input.openerTabId ?? jarvisTarget.browserTabId,
    }) as Promise<BrowserTab>,
};

contextBridge.exposeInMainWorld("jarvisExtensionPopup", extensionPopup);
