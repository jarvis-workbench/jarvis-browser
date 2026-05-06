import { dialog, ipcMain } from "electron";
import type { AppApi, BrowserRect } from "../shared/types";
import { BrowserHost } from "./browser-host";
import { getElectronSession } from "./electron-session-manager";
import { MetadataStore } from "./store";

const invoke = <T>(work: () => Promise<T> | T) => async () => work();

export const registerIpc = (store: MetadataStore, browserHost: BrowserHost) => {
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
  ipcMain.handle("browser:navigate", (_event, url: string) => browserHost.navigate(url));
  ipcMain.handle("browser:back", () => browserHost.back());
  ipcMain.handle("browser:forward", () => browserHost.forward());
  ipcMain.handle("browser:reload", () => browserHost.reload());
  ipcMain.handle("browser:reload-error-page", () => browserHost.reloadErrorPage());
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
