import { dialog, ipcMain } from "electron";
import type {
  AppApi,
  AutomationBridgeSettings,
  BrowserRect,
  CookieRemoveDetails,
  CookieSetDetails,
} from "../shared/types";
import { AutomationBridge } from "./automation-bridge";
import { BrowserHost } from "./browser-host";
import { parseBrowserOverlayAction } from "./browser-overlay-menu";
import { getElectronSession } from "./electron-session-manager";
import { HistoryManager } from "./history-manager";
import { SessionSyncManager } from "./session-sync-manager";
import { StorageManager } from "./storage-manager";
import { MetadataStore } from "./store";
import { UpdateManager } from "./update-manager";

export class IpcRouter {
  private readonly sessionSyncManager: SessionSyncManager;

  constructor(
    private readonly store: MetadataStore,
    private readonly browserHost: BrowserHost,
    private readonly historyManager: HistoryManager,
    private readonly storageManager: StorageManager,
    private readonly updateManager: UpdateManager,
    private readonly automationBridge: AutomationBridge,
  ) {
    this.sessionSyncManager = new SessionSyncManager(store, browserHost);
  }

  register() {
    // Sites
    this.route("sites:list", () => this.store.listSites());
    this.route("sites:add", async (_event, input: Parameters<AppApi["sites"]["add"]>[0]) => {
      const site = await this.store.addSite(input);
      this.browserHost.emitSiteMetadataUpdated();
      return site;
    });
    this.route(
      "sites:update",
      async (_event, siteId: string, input: Parameters<AppApi["sites"]["update"]>[1]) => {
        const site = await this.store.updateSite(siteId, input);
        this.browserHost.emitSiteMetadataUpdated();
        return site;
      },
    );
    this.route("sites:reorder", async (_event, siteIds: string[]) => {
      const sites = await this.store.reorderSites(siteIds);
      this.browserHost.emitSiteMetadataUpdated();
      return sites;
    });
    this.route("sites:delete", async (_event, siteId: string) => {
      await this.store.deleteSite(siteId);
      this.browserHost.emitSiteMetadataUpdated();
    });

    // Sessions
    this.route("sessions:list", (_event, siteId: string) => {
      const site = this.store.getSite(siteId);
      if (!site) {
        throw new Error("站点不存在");
      }
      return this.store.listSites().find((item) => item.id === siteId)!.sessions;
    });
    this.route("sessions:add", async (_event, siteId: string, input: { name: string }) => {
      const session = await this.store.addSession(siteId, input);
      this.browserHost.emitSiteMetadataUpdated();
      return session;
    });
    this.route("sessions:rename", async (_event, siteId: string, sessionId: string, name: string) => {
      const session = await this.store.renameSession(siteId, sessionId, name);
      this.browserHost.emitSiteMetadataUpdated();
      return session;
    });
    this.route("sessions:delete", async (_event, siteId: string, sessionId: string) => {
      await this.browserHost.closeSession(siteId, sessionId);
      const result = await this.store.deleteSession(siteId, sessionId);
      this.browserHost.emitSiteMetadataUpdated();
      return result;
    });
    this.route(
      "sessions:clear-data",
      async (
        _event,
        siteId: string,
        sessionId: string,
        options: Parameters<AppApi["sessions"]["clearData"]>[2],
      ) => {
        const siteSession = this.store.getSession(siteId, sessionId);
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
          await Promise.all([
            targetSession.clearCache(),
            targetSession.clearStorageData({ storages: ["cachestorage"] }),
          ]);
        }
      },
    );

    // Browser
    this.route("browser:open", (_event, siteId: string, sessionId: string) =>
      this.browserHost.open(siteId, sessionId),
    );
    this.route("browser:create-tab", (_event, input: Parameters<AppApi["browser"]["createTab"]>[0]) =>
      this.browserHost.createTab(input),
    );
    this.route("browser:create-site-tab", (_event, input: Parameters<AppApi["browser"]["createSiteTab"]>[0]) =>
      this.browserHost.createSiteTab(input),
    );
    this.route("browser:open-internal-page", (_event, input: Parameters<AppApi["browser"]["openInternalPage"]>[0]) =>
      this.browserHost.openInternalPage(input),
    );
    this.route("browser:list-tabs", () => this.browserHost.listTabs());
    this.route("browser:activate-tab", (_event, tabId: string) => this.browserHost.activateTab(tabId));
    this.route("browser:reorder-tabs", (_event, tabIds: string[]) => this.browserHost.reorderTabs(tabIds));
    this.route("browser:close-tab", (_event, tabId: string) => this.browserHost.closeTab(tabId));
    this.route("browser:navigate-tab", (_event, tabId: string, url: string) => this.browserHost.navigateTab(tabId, url));
    this.route("browser:navigate", (_event, url: string) => this.browserHost.navigate(url));
    this.route("browser:back", () => this.browserHost.back());
    this.route("browser:forward", () => this.browserHost.forward());
    this.route("browser:reload", () => this.browserHost.reload());
    this.route("browser:reload-internal-error", () => this.browserHost.reloadErrorPage());
    this.route("browser:stop", () => this.browserHost.stop());
    this.route("browser:show-home", () => this.browserHost.showHome());
    this.route("browser:hide-embedded-view", () => this.browserHost.hideEmbeddedView());
    this.route("browser:show-active-view", () => this.browserHost.showActiveView());
    this.route("browser:set-bounds", (_event, rect: BrowserRect) => this.browserHost.setBounds(rect));
    this.route("browser:close", () => this.browserHost.close());
    this.route("browser:close-session", (_event, siteId: string, sessionId: string) =>
      this.browserHost.closeSession(siteId, sessionId),
    );
    this.route("browser:debug-state", () => this.browserHost.getDebugState());

    // Overlays
    this.route("overlays:open-extension-menu", (_event, input: Parameters<AppApi["overlays"]["openExtensionMenu"]>[0]) =>
      this.browserHost.openExtensionMenu(input),
    );
    this.route("overlays:open-downloads-bubble", (_event, input: Parameters<AppApi["overlays"]["openDownloadsBubble"]>[0]) =>
      this.browserHost.openDownloadsBubble(input),
    );
    this.route("overlays:open-app-menu", (_event, input: Parameters<AppApi["overlays"]["openAppMenu"]>[0]) =>
      this.browserHost.openAppMenu(input),
    );
    this.route("overlays:action", (_event, input: { action: string; id: string; anchor?: BrowserRect }) =>
      this.dispatchOverlayAction(input),
    );
    this.route("overlays:close", () => this.browserHost.closeOverlay());

    // Extensions
    this.route("extensions:list-global", () => this.store.listGlobalExtensions());
    this.route("extensions:list-site", (_event, siteId: string) => {
      const site = this.store.getSite(siteId);
      if (!site) {
        throw new Error("站点不存在");
      }
      return site.extensions;
    });
    this.route("extensions:install-global", () => this.browserHost.installGlobalUnpacked());
    this.route("extensions:install-site", (_event, siteId: string) => this.browserHost.installSiteUnpacked(siteId));
    this.route("extensions:enable-global", (_event, extensionId: string) =>
      this.browserHost.enableGlobalExtension(extensionId),
    );
    this.route("extensions:disable-global", (_event, extensionId: string) =>
      this.browserHost.disableGlobalExtension(extensionId),
    );
    this.route("extensions:uninstall-global", (_event, extensionId: string) =>
      this.browserHost.uninstallGlobalExtension(extensionId),
    );
    this.route("extensions:enable-site", (_event, siteId: string, extensionId: string) =>
      this.browserHost.enableSiteExtension(siteId, extensionId),
    );
    this.route("extensions:disable-site", (_event, siteId: string, extensionId: string) =>
      this.browserHost.disableSiteExtension(siteId, extensionId),
    );
    this.route("extensions:uninstall-site", (_event, siteId: string, extensionId: string) =>
      this.browserHost.uninstallSiteExtension(siteId, extensionId),
    );
    this.route(
      "extensions:open-popup",
      (_event, input: Parameters<AppApi["extensions"]["openPopup"]>[0]) =>
        this.browserHost.openExtensionPopup(input),
    );
    this.route("extensions:close-popup", () => this.browserHost.closeExtensionPopup());
    this.route("extension-popup:cookies-set", (_event, details: CookieSetDetails) =>
      this.browserHost.setActiveSessionCookie(details),
    );
    this.route("extension-popup:cookies-remove", (_event, details: CookieRemoveDetails) =>
      this.browserHost.removeActiveSessionCookie(details),
    );

    // Jarvis Scripts
    this.route("jarvis-scripts:list-global", () => this.browserHost.listGlobalJarvisScripts());
    this.route("jarvis-scripts:list-site", (_event, siteId: string) =>
      this.browserHost.listSiteJarvisScripts(siteId),
    );
    this.route("jarvis-scripts:install-global", () =>
      this.browserHost.installGlobalJarvisScript(),
    );
    this.route("jarvis-scripts:install-site", (_event, siteId: string) =>
      this.browserHost.installSiteJarvisScript(siteId),
    );
    this.route("jarvis-scripts:enable-global", (_event, scriptId: string) =>
      this.browserHost.enableGlobalJarvisScript(scriptId),
    );
    this.route("jarvis-scripts:disable-global", (_event, scriptId: string) =>
      this.browserHost.disableGlobalJarvisScript(scriptId),
    );
    this.route("jarvis-scripts:uninstall-global", (_event, scriptId: string) =>
      this.browserHost.uninstallGlobalJarvisScript(scriptId),
    );
    this.route("jarvis-scripts:enable-site", (_event, siteId: string, scriptId: string) =>
      this.browserHost.enableSiteJarvisScript(siteId, scriptId),
    );
    this.route("jarvis-scripts:disable-site", (_event, siteId: string, scriptId: string) =>
      this.browserHost.disableSiteJarvisScript(siteId, scriptId),
    );
    this.route("jarvis-scripts:uninstall-site", (_event, siteId: string, scriptId: string) =>
      this.browserHost.uninstallSiteJarvisScript(siteId, scriptId),
    );

    // Downloads
    this.route("downloads:list", () => this.store.listDownloads());
    this.route("downloads:pause", (_event, downloadId: string) => this.browserHost.pauseDownload(downloadId));
    this.route("downloads:resume", (_event, downloadId: string) => this.browserHost.resumeDownload(downloadId));
    this.route("downloads:cancel", (_event, downloadId: string) => this.browserHost.cancelDownload(downloadId));
    this.route("downloads:open", (_event, downloadId: string) => this.browserHost.openDownload(downloadId));
    this.route("downloads:show-in-folder", (_event, downloadId: string) => this.browserHost.showDownloadInFolder(downloadId));
    this.route("downloads:remove", (_event, downloadId: string) => this.store.removeDownload(downloadId));
    this.route("downloads:clear", () => this.store.clearDownloads());

    // History
    this.route("history:list", (_event, input: Parameters<AppApi["history"]["list"]>[0]) =>
      this.historyManager.list(input),
    );
    this.route("history:clear", (_event, input: Parameters<AppApi["history"]["clear"]>[0]) =>
      this.historyManager.clear(input),
    );

    // Storage
    this.route("storage:stats", (_event, input: Parameters<AppApi["storage"]["stats"]>[0]) =>
      this.storageManager.stats(input),
    );
    this.route("storage:clear-data", (_event, input: Parameters<AppApi["storage"]["clearData"]>[0]) =>
      this.storageManager.clearData(input),
    );

    // Session Sync
    this.route("session-sync:export", (_event, input: Parameters<AppApi["sessionSync"]["export"]>[0]) =>
      this.sessionSyncManager.export(input),
    );
    this.route("session-sync:preview-import", (_event, input: Parameters<AppApi["sessionSync"]["previewImport"]>[0]) =>
      this.sessionSyncManager.previewImport(input),
    );
    this.route("session-sync:apply-import", async (_event, input: Parameters<AppApi["sessionSync"]["applyImport"]>[0]) => {
      const result = await this.sessionSyncManager.applyImport(input);
      this.browserHost.emitSiteMetadataUpdated();
      return result;
    });
    this.route("session-sync:cancel-import", (_event, importId: string) =>
      this.sessionSyncManager.cancelImport(importId),
    );

    // Settings
    this.route("settings:get", () => this.store.getDownloadSettings());
    this.route("settings:update", (_event, input: Parameters<AppApi["settings"]["update"]>[0]) =>
      this.store.updateDownloadSettings(input),
    );
    this.route("settings:select-download-path", async () => {
      const result = await dialog.showOpenDialog({
        properties: ["openDirectory", "createDirectory"],
        defaultPath: this.store.getDownloadSettings().downloadPath,
      });
      return result.canceled ? undefined : result.filePaths[0];
    });
    this.route("settings:get-automation-bridge", () => this.automationBridge.getStatus());
    this.route(
      "settings:update-automation-bridge",
      async (_event, input: Partial<Pick<AutomationBridgeSettings, "enabled" | "port">>) => {
        const settings = await this.store.updateAutomationBridgeSettings(input);
        return this.automationBridge.applySettings(settings);
      },
    );
    this.route("settings:regenerate-automation-bridge-token", async () => {
      const settings = await this.store.regenerateAutomationBridgeToken();
      return this.automationBridge.applySettings(settings);
    });

    // Updates
    this.route("updates:get-status", () => this.updateManager.getStatus());
    this.route("updates:check-for-updates", () => this.updateManager.checkForUpdates());
    this.route("updates:download-update", () => this.updateManager.downloadUpdate());
    this.route("updates:quit-and-install", () => this.updateManager.quitAndInstall());
  }

  private route(channel: string, handler: (...args: any[]) => any) {
    ipcMain.handle(channel, async (event, ...args) => {
      try {
        return await handler(event, ...args);
      } catch (error) {
        console.error(`[IPC Error] Channel "${channel}" failed:`, error);
        throw error;
      }
    });
  }

  private async dispatchOverlayAction(input: { action: string; id: string; anchor?: BrowserRect }) {
    const action = parseBrowserOverlayAction(input.action);
    this.browserHost.closeOverlay();

    switch (action) {
      case "extension-popup": {
        if (!input.anchor) {
          throw new Error("浮层动作缺少锚点");
        }
        const activeTab = this.browserHost.getActiveTab();
        if (!activeTab || !activeTab.siteId || !activeTab.sessionId) {
          throw new Error("当前标签不是站点会话");
        }
        await this.browserHost.openExtensionPopup({
          siteId: activeTab.siteId,
          sessionId: activeTab.sessionId,
          extensionId: input.id,
          anchor: input.anchor,
        });
        break;
      }
      case "extensions":
        await this.browserHost.openInternalPage({ pageId: "extensions" });
        break;
      case "install-site-extension": {
        const activeTab = this.browserHost.getActiveTab();
        if (activeTab?.siteId) {
          await this.browserHost.installSiteUnpacked(activeTab.siteId);
        }
        break;
      }
      case "downloads":
        await this.browserHost.openInternalPage({ pageId: "downloads" });
        break;
      case "settings":
        await this.browserHost.openInternalPage({ pageId: "settings" });
        break;
      case "history":
        await this.browserHost.openInternalPage({ pageId: "history" });
        break;
      case "session-sync":
        // 统一向渲染进程发送事件
        setTimeout(() => {
          this.browserHost.sendToWebContents("session-sync:open-dialog", { scope: "global", hideActiveView: true });
        }, 0);
        break;
      case "clear-browsing-data":
        await this.browserHost.openInternalPage({ pageId: "clear-browsing-data" });
        break;
      case "jarvis-script":
        await this.browserHost.openInternalPage({ pageId: "jarvis-script" });
        break;
    }
  }
}
