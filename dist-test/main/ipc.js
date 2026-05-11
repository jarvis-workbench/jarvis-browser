"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerIpc = void 0;
const electron_1 = require("electron");
const browser_overlay_menu_1 = require("./browser-overlay-menu");
const electron_session_manager_1 = require("./electron-session-manager");
const invoke = (work) => async () => work();
const registerIpc = (store, browserHost, historyManager, storageManager) => {
    electron_1.ipcMain.handle("sites:list", invoke(() => store.listSites()));
    electron_1.ipcMain.handle("sites:add", (_event, input) => store.addSite(input));
    electron_1.ipcMain.handle("sites:update", (_event, siteId, input) => store.updateSite(siteId, input));
    electron_1.ipcMain.handle("sites:delete", (_event, siteId) => store.deleteSite(siteId));
    electron_1.ipcMain.handle("sessions:list", (_event, siteId) => {
        const site = store.getSite(siteId);
        if (!site) {
            throw new Error("站点不存在");
        }
        return store.listSites().find((item) => item.id === siteId).sessions;
    });
    electron_1.ipcMain.handle("sessions:add", (_event, siteId, input) => store.addSession(siteId, input));
    electron_1.ipcMain.handle("sessions:rename", (_event, siteId, sessionId, name) => store.renameSession(siteId, sessionId, name));
    electron_1.ipcMain.handle("sessions:delete", async (_event, siteId, sessionId) => {
        await browserHost.closeSession(siteId, sessionId);
        return store.deleteSession(siteId, sessionId);
    });
    electron_1.ipcMain.handle("sessions:clear-data", async (_event, siteId, sessionId, options) => {
        const siteSession = store.getSession(siteId, sessionId);
        if (!siteSession) {
            throw new Error("会话不存在");
        }
        const targetSession = (0, electron_session_manager_1.getElectronSession)(siteId, sessionId);
        await targetSession.clearStorageData({
            storages: [
                ...(options.cookies ? ["cookies"] : []),
                ...(options.storage ? ["localstorage", "indexdb"] : []),
            ],
        });
        if (options.cache) {
            await targetSession.clearCache();
        }
    });
    electron_1.ipcMain.handle("browser:open", (_event, siteId, sessionId) => browserHost.open(siteId, sessionId));
    electron_1.ipcMain.handle("browser:create-tab", (_event, input) => browserHost.createTab(input));
    electron_1.ipcMain.handle("browser:create-site-tab", (_event, input) => browserHost.createSiteTab(input));
    electron_1.ipcMain.handle("browser:open-internal-page", (_event, input) => browserHost.openInternalPage(input));
    electron_1.ipcMain.handle("browser:list-tabs", () => browserHost.listTabs());
    electron_1.ipcMain.handle("browser:activate-tab", (_event, tabId) => browserHost.activateTab(tabId));
    electron_1.ipcMain.handle("browser:close-tab", (_event, tabId) => browserHost.closeTab(tabId));
    electron_1.ipcMain.handle("browser:navigate-tab", (_event, tabId, url) => browserHost.navigateTab(tabId, url));
    electron_1.ipcMain.handle("browser:navigate", (_event, url) => browserHost.navigate(url));
    electron_1.ipcMain.handle("browser:back", () => browserHost.back());
    electron_1.ipcMain.handle("browser:forward", () => browserHost.forward());
    electron_1.ipcMain.handle("browser:reload", () => browserHost.reload());
    electron_1.ipcMain.handle("browser:reload-internal-error", () => browserHost.reloadErrorPage());
    electron_1.ipcMain.handle("browser:stop", () => browserHost.stop());
    electron_1.ipcMain.handle("browser:show-home", () => browserHost.showHome());
    electron_1.ipcMain.handle("browser:hide-embedded-view", () => browserHost.hideEmbeddedView());
    electron_1.ipcMain.handle("browser:show-active-view", () => browserHost.showActiveView());
    electron_1.ipcMain.handle("browser:set-bounds", (_event, rect) => browserHost.setBounds(rect));
    electron_1.ipcMain.handle("browser:close", () => browserHost.close());
    electron_1.ipcMain.handle("browser:close-session", (_event, siteId, sessionId) => browserHost.closeSession(siteId, sessionId));
    electron_1.ipcMain.handle("browser:debug-state", () => browserHost.getDebugState());
    electron_1.ipcMain.handle("overlays:open-extension-menu", (_event, input) => browserHost.openExtensionMenu(input));
    electron_1.ipcMain.handle("overlays:open-downloads-bubble", (_event, input) => browserHost.openDownloadsBubble(input));
    electron_1.ipcMain.handle("overlays:open-app-menu", (_event, input) => browserHost.openAppMenu(input));
    electron_1.ipcMain.handle("overlays:action", (_event, input) => browserHost.handleOverlayAction({
        action: (0, browser_overlay_menu_1.parseBrowserOverlayAction)(input.action),
        id: input.id,
        anchor: input.anchor,
    }));
    electron_1.ipcMain.handle("overlays:close", () => browserHost.closeOverlay());
    electron_1.ipcMain.handle("extensions:list-global", invoke(() => store.listGlobalExtensions()));
    electron_1.ipcMain.handle("extensions:list-site", (_event, siteId) => {
        const site = store.getSite(siteId);
        if (!site) {
            throw new Error("站点不存在");
        }
        return site.extensions;
    });
    electron_1.ipcMain.handle("extensions:install-global", () => browserHost.installGlobalUnpacked());
    electron_1.ipcMain.handle("extensions:install-site", (_event, siteId) => browserHost.installSiteUnpacked(siteId));
    electron_1.ipcMain.handle("extensions:enable-global", (_event, extensionId) => browserHost.enableGlobalExtension(extensionId));
    electron_1.ipcMain.handle("extensions:disable-global", (_event, extensionId) => browserHost.disableGlobalExtension(extensionId));
    electron_1.ipcMain.handle("extensions:uninstall-global", (_event, extensionId) => browserHost.uninstallGlobalExtension(extensionId));
    electron_1.ipcMain.handle("extensions:enable-site", (_event, siteId, extensionId) => browserHost.enableSiteExtension(siteId, extensionId));
    electron_1.ipcMain.handle("extensions:disable-site", (_event, siteId, extensionId) => browserHost.disableSiteExtension(siteId, extensionId));
    electron_1.ipcMain.handle("extensions:uninstall-site", (_event, siteId, extensionId) => browserHost.uninstallSiteExtension(siteId, extensionId));
    electron_1.ipcMain.handle("extensions:open-popup", (_event, input) => browserHost.openExtensionPopup(input));
    electron_1.ipcMain.handle("extensions:close-popup", () => browserHost.closeExtensionPopup());
    electron_1.ipcMain.handle("extension-popup:cookies-set", (_event, details) => browserHost.setActiveSessionCookie(details));
    electron_1.ipcMain.handle("extension-popup:cookies-remove", (_event, details) => browserHost.removeActiveSessionCookie(details));
    electron_1.ipcMain.handle("jarvis-scripts:list-global", invoke(() => browserHost.listGlobalJarvisScripts()));
    electron_1.ipcMain.handle("jarvis-scripts:list-site", (_event, siteId) => browserHost.listSiteJarvisScripts(siteId));
    electron_1.ipcMain.handle("jarvis-scripts:install-global", () => browserHost.installGlobalJarvisScript());
    electron_1.ipcMain.handle("jarvis-scripts:install-site", (_event, siteId) => browserHost.installSiteJarvisScript(siteId));
    electron_1.ipcMain.handle("jarvis-scripts:enable-global", (_event, scriptId) => browserHost.enableGlobalJarvisScript(scriptId));
    electron_1.ipcMain.handle("jarvis-scripts:disable-global", (_event, scriptId) => browserHost.disableGlobalJarvisScript(scriptId));
    electron_1.ipcMain.handle("jarvis-scripts:uninstall-global", (_event, scriptId) => browserHost.uninstallGlobalJarvisScript(scriptId));
    electron_1.ipcMain.handle("jarvis-scripts:enable-site", (_event, siteId, scriptId) => browserHost.enableSiteJarvisScript(siteId, scriptId));
    electron_1.ipcMain.handle("jarvis-scripts:disable-site", (_event, siteId, scriptId) => browserHost.disableSiteJarvisScript(siteId, scriptId));
    electron_1.ipcMain.handle("jarvis-scripts:uninstall-site", (_event, siteId, scriptId) => browserHost.uninstallSiteJarvisScript(siteId, scriptId));
    electron_1.ipcMain.handle("downloads:list", invoke(() => store.listDownloads()));
    electron_1.ipcMain.handle("downloads:pause", (_event, downloadId) => browserHost.pauseDownload(downloadId));
    electron_1.ipcMain.handle("downloads:resume", (_event, downloadId) => browserHost.resumeDownload(downloadId));
    electron_1.ipcMain.handle("downloads:cancel", (_event, downloadId) => browserHost.cancelDownload(downloadId));
    electron_1.ipcMain.handle("downloads:open", (_event, downloadId) => browserHost.openDownload(downloadId));
    electron_1.ipcMain.handle("downloads:show-in-folder", (_event, downloadId) => browserHost.showDownloadInFolder(downloadId));
    electron_1.ipcMain.handle("downloads:remove", (_event, downloadId) => store.removeDownload(downloadId));
    electron_1.ipcMain.handle("downloads:clear", invoke(() => store.clearDownloads()));
    electron_1.ipcMain.handle("history:list", (_event, input) => historyManager.list(input));
    electron_1.ipcMain.handle("history:clear", (_event, input) => historyManager.clear(input));
    electron_1.ipcMain.handle("storage:stats", (_event, input) => storageManager.stats(input));
    electron_1.ipcMain.handle("storage:clear-data", (_event, input) => storageManager.clearData(input));
    electron_1.ipcMain.handle("settings:get", invoke(() => store.getDownloadSettings()));
    electron_1.ipcMain.handle("settings:update", (_event, input) => store.updateDownloadSettings(input));
    electron_1.ipcMain.handle("settings:select-download-path", async () => {
        const result = await electron_1.dialog.showOpenDialog({
            properties: ["openDirectory", "createDirectory"],
            defaultPath: store.getDownloadSettings().downloadPath,
        });
        return result.canceled ? undefined : result.filePaths[0];
    });
};
exports.registerIpc = registerIpc;
