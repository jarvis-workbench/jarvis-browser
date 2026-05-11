import { dialog, ipcMain } from "electron";
import type { AppApi, BrowserRect, CookieRemoveDetails, CookieSetDetails } from "../shared/types";
import { BrowserHost } from "./browser-host";
import { parseBrowserOverlayAction } from "./browser-overlay-menu";
import { getElectronSession } from "./electron-session-manager";
import { HistoryManager } from "./history-manager";
import { StorageManager } from "./storage-manager";
import { MetadataStore } from "./store";

const invoke = <T>(work: () => Promise<T> | T) => async () => work();

export const registerIpc = (
  store: MetadataStore,
  browserHost: BrowserHost,
  historyManager: HistoryManager,
  storageManager: StorageManager,
) => {
  ipcMain.handle("sites:list", invoke(() => store.listSites()));
  ipcMain.handle("sites:add", (_event, input: Parameters<AppApi["sites"]["add"]>[0]) =>
    store.addSite(input),
  );
  ipcMain.handle(
    "sites:update",
    (_event, siteId: string, input: Parameters<AppApi["sites"]["update"]>[1]) =>
      store.updateSite(siteId, input),
  );
  ipcMain.handle("sites:delete", (_event, siteId: string) => store.deleteSite(siteId));
  ipcMain.handle("sessions:list", (_event, siteId: string) => {
    const site = store.getSite(siteId);
    if (!site) {
      throw new Error("站点不存在");
    }

    return store.listSites().find((item) => item.id === siteId)!.sessions;
  });
  ipcMain.handle("sessions:add", (_event, siteId: string, input: { name: string }) =>
    store.addSession(siteId, input),
  );
  ipcMain.handle("sessions:rename", (_event, siteId: string, sessionId: string, name: string) =>
    store.renameSession(siteId, sessionId, name),
  );
  ipcMain.handle("sessions:delete", async (_event, siteId: string, sessionId: string) => {
    await browserHost.closeSession(siteId, sessionId);
    return store.deleteSession(siteId, sessionId);
  });
  ipcMain.handle(
    "sessions:clear-data",
    async (
      _event,
      siteId: string,
      sessionId: string,
      options: Parameters<AppApi["sessions"]["clearData"]>[2],
    ) => {
      const siteSession = store.getSession(siteId, sessionId);
      if (!siteSession) {
        throw new Error("会话不存在");
      }

      const targetSession = getElectronSession(siteId, sessionId);
      await targetSession.clearStorageData({
        storages: [
          ...(options.cookies ? ["cookies" as const] : []),
          ...(options.storage ? ["localstorage" as const, "indexdb" as const] : []),
        ],
      });

      if (options.cache) {
        await targetSession.clearCache();
      }
    },
  );
  ipcMain.handle("browser:open", (_event, siteId: string, sessionId: string) =>
    browserHost.open(siteId, sessionId),
  );
  ipcMain.handle("browser:create-tab", (_event, input: Parameters<AppApi["browser"]["createTab"]>[0]) =>
    browserHost.createTab(input),
  );
  ipcMain.handle("browser:create-site-tab", (_event, input: Parameters<AppApi["browser"]["createSiteTab"]>[0]) =>
    browserHost.createSiteTab(input),
  );
  ipcMain.handle("browser:open-internal-page", (_event, input: Parameters<AppApi["browser"]["openInternalPage"]>[0]) =>
    browserHost.openInternalPage(input),
  );
  ipcMain.handle("browser:list-tabs", () => browserHost.listTabs());
  ipcMain.handle("browser:activate-tab", (_event, tabId: string) => browserHost.activateTab(tabId));
  ipcMain.handle("browser:close-tab", (_event, tabId: string) => browserHost.closeTab(tabId));
  ipcMain.handle("browser:navigate-tab", (_event, tabId: string, url: string) => browserHost.navigateTab(tabId, url));
  ipcMain.handle("browser:navigate", (_event, url: string) => browserHost.navigate(url));
  ipcMain.handle("browser:back", () => browserHost.back());
  ipcMain.handle("browser:forward", () => browserHost.forward());
  ipcMain.handle("browser:reload", () => browserHost.reload());
  ipcMain.handle("browser:reload-internal-error", () => browserHost.reloadErrorPage());
  ipcMain.handle("browser:stop", () => browserHost.stop());
  ipcMain.handle("browser:show-home", () => browserHost.showHome());
  ipcMain.handle("browser:hide-embedded-view", () => browserHost.hideEmbeddedView());
  ipcMain.handle("browser:show-active-view", () => browserHost.showActiveView());
  ipcMain.handle("browser:set-bounds", (_event, rect: BrowserRect) => browserHost.setBounds(rect));
  ipcMain.handle("browser:close", () => browserHost.close());
  ipcMain.handle("browser:close-session", (_event, siteId: string, sessionId: string) =>
    browserHost.closeSession(siteId, sessionId),
  );
  ipcMain.handle("browser:debug-state", () => browserHost.getDebugState());
  ipcMain.handle("overlays:open-extension-menu", (_event, input: Parameters<AppApi["overlays"]["openExtensionMenu"]>[0]) =>
    browserHost.openExtensionMenu(input),
  );
  ipcMain.handle("overlays:open-downloads-bubble", (_event, input: Parameters<AppApi["overlays"]["openDownloadsBubble"]>[0]) =>
    browserHost.openDownloadsBubble(input),
  );
  ipcMain.handle("overlays:open-app-menu", (_event, input: Parameters<AppApi["overlays"]["openAppMenu"]>[0]) =>
    browserHost.openAppMenu(input),
  );
  ipcMain.handle("overlays:action", (_event, input: { action: string; id: string; anchor?: BrowserRect }) =>
    browserHost.handleOverlayAction({
      action: parseBrowserOverlayAction(input.action),
      id: input.id,
      anchor: input.anchor,
    }),
  );
  ipcMain.handle("overlays:close", () => browserHost.closeOverlay());

  ipcMain.handle("extensions:list-global", invoke(() => store.listGlobalExtensions()));
  ipcMain.handle("extensions:list-site", (_event, siteId: string) => {
    const site = store.getSite(siteId);
    if (!site) {
      throw new Error("站点不存在");
    }

    return site.extensions;
  });
  ipcMain.handle("extensions:install-global", () => browserHost.installGlobalUnpacked());
  ipcMain.handle("extensions:install-site", (_event, siteId: string) => browserHost.installSiteUnpacked(siteId));
  ipcMain.handle("extensions:enable-global", (_event, extensionId: string) =>
    browserHost.enableGlobalExtension(extensionId),
  );
  ipcMain.handle("extensions:disable-global", (_event, extensionId: string) =>
    browserHost.disableGlobalExtension(extensionId),
  );
  ipcMain.handle("extensions:uninstall-global", (_event, extensionId: string) =>
    browserHost.uninstallGlobalExtension(extensionId),
  );
  ipcMain.handle("extensions:enable-site", (_event, siteId: string, extensionId: string) =>
    browserHost.enableSiteExtension(siteId, extensionId),
  );
  ipcMain.handle("extensions:disable-site", (_event, siteId: string, extensionId: string) =>
    browserHost.disableSiteExtension(siteId, extensionId),
  );
  ipcMain.handle("extensions:uninstall-site", (_event, siteId: string, extensionId: string) =>
    browserHost.uninstallSiteExtension(siteId, extensionId),
  );
  ipcMain.handle(
    "extensions:open-popup",
    (_event, input: Parameters<AppApi["extensions"]["openPopup"]>[0]) =>
      browserHost.openExtensionPopup(input),
  );
  ipcMain.handle("extensions:close-popup", () => browserHost.closeExtensionPopup());
  ipcMain.handle("extension-popup:cookies-set", (_event, details: CookieSetDetails) =>
    browserHost.setActiveSessionCookie(details),
  );
  ipcMain.handle("extension-popup:cookies-remove", (_event, details: CookieRemoveDetails) =>
    browserHost.removeActiveSessionCookie(details),
  );

  ipcMain.handle("jarvis-scripts:list-global", invoke(() => browserHost.listGlobalJarvisScripts()));
  ipcMain.handle("jarvis-scripts:list-site", (_event, siteId: string) =>
    browserHost.listSiteJarvisScripts(siteId),
  );
  ipcMain.handle("jarvis-scripts:install-global", () =>
    browserHost.installGlobalJarvisScript(),
  );
  ipcMain.handle("jarvis-scripts:install-site", (_event, siteId: string) =>
    browserHost.installSiteJarvisScript(siteId),
  );
  ipcMain.handle("jarvis-scripts:enable-global", (_event, scriptId: string) =>
    browserHost.enableGlobalJarvisScript(scriptId),
  );
  ipcMain.handle("jarvis-scripts:disable-global", (_event, scriptId: string) =>
    browserHost.disableGlobalJarvisScript(scriptId),
  );
  ipcMain.handle("jarvis-scripts:uninstall-global", (_event, scriptId: string) =>
    browserHost.uninstallGlobalJarvisScript(scriptId),
  );
  ipcMain.handle("jarvis-scripts:enable-site", (_event, siteId: string, scriptId: string) =>
    browserHost.enableSiteJarvisScript(siteId, scriptId),
  );
  ipcMain.handle("jarvis-scripts:disable-site", (_event, siteId: string, scriptId: string) =>
    browserHost.disableSiteJarvisScript(siteId, scriptId),
  );
  ipcMain.handle("jarvis-scripts:uninstall-site", (_event, siteId: string, scriptId: string) =>
    browserHost.uninstallSiteJarvisScript(siteId, scriptId),
  );
  ipcMain.handle("downloads:list", invoke(() => store.listDownloads()));
  ipcMain.handle("downloads:pause", (_event, downloadId: string) => browserHost.pauseDownload(downloadId));
  ipcMain.handle("downloads:resume", (_event, downloadId: string) => browserHost.resumeDownload(downloadId));
  ipcMain.handle("downloads:cancel", (_event, downloadId: string) => browserHost.cancelDownload(downloadId));
  ipcMain.handle("downloads:open", (_event, downloadId: string) => browserHost.openDownload(downloadId));
  ipcMain.handle("downloads:show-in-folder", (_event, downloadId: string) => browserHost.showDownloadInFolder(downloadId));
  ipcMain.handle("downloads:remove", (_event, downloadId: string) => store.removeDownload(downloadId));
  ipcMain.handle("downloads:clear", invoke(() => store.clearDownloads()));
  ipcMain.handle("history:list", (_event, input: Parameters<AppApi["history"]["list"]>[0]) =>
    historyManager.list(input),
  );
  ipcMain.handle("history:clear", (_event, input: Parameters<AppApi["history"]["clear"]>[0]) =>
    historyManager.clear(input),
  );
  ipcMain.handle("storage:stats", (_event, input: Parameters<AppApi["storage"]["stats"]>[0]) =>
    storageManager.stats(input),
  );
  ipcMain.handle("storage:clear-data", (_event, input: Parameters<AppApi["storage"]["clearData"]>[0]) =>
    storageManager.clearData(input),
  );
  ipcMain.handle("settings:get", invoke(() => store.getDownloadSettings()));
  ipcMain.handle("settings:update", (_event, input: Parameters<AppApi["settings"]["update"]>[0]) =>
    store.updateDownloadSettings(input),
  );
  ipcMain.handle("settings:select-download-path", async () => {
    const result = await dialog.showOpenDialog({
      properties: ["openDirectory", "createDirectory"],
      defaultPath: store.getDownloadSettings().downloadPath,
    });
    return result.canceled ? undefined : result.filePaths[0];
  });
};
