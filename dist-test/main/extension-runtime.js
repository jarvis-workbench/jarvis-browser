"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ExtensionRuntime = void 0;
const electron_1 = require("electron");
const electron_session_manager_1 = require("./electron-session-manager");
const extension_manifest_1 = require("./extension-manifest");
class ExtensionRuntime {
    window;
    store;
    bindSessionDownloads;
    constructor(window, store, bindSessionDownloads) {
        this.window = window;
        this.store = store;
        this.bindSessionDownloads = bindSessionDownloads;
    }
    async loadEnabledForSite(site) {
        for (const extension of this.store.listGlobalExtensions()) {
            if (extension.enabled) {
                await this.loadForSite(site, extension);
            }
        }
        for (const extension of site.extensions) {
            if (extension.enabled) {
                await this.loadForSite(site, extension);
            }
        }
    }
    async loadEnabledForDefaultProfile() {
        for (const extension of this.store.listGlobalExtensions()) {
            if (extension.enabled) {
                await this.loadForDefaultProfile(extension);
            }
        }
    }
    async installGlobalUnpacked() {
        const paths = await this.pickExtensionPath();
        if (!paths) {
            return undefined;
        }
        const extension = await this.store.installGlobalExtensionSource(await (0, extension_manifest_1.createExtensionFromPath)(paths[0]), paths[0]);
        try {
            const loaded = await this.loadForAllSites(extension);
            if (loaded) {
                extension.id = loaded.id;
                extension.name = loaded.name || extension.name;
                extension.version = loaded.version || extension.version;
            }
        }
        catch (error) {
            extension.loadError = formatError(error);
        }
        return this.store.upsertGlobalExtension(extension);
    }
    async installSiteUnpacked(siteId) {
        const site = this.store.getSite(siteId);
        if (!site) {
            throw new Error("站点不存在");
        }
        const paths = await this.pickExtensionPath();
        if (!paths) {
            return undefined;
        }
        if (site.sessions.length === 0) {
            throw new Error("请先创建站点会话再安装扩展程序");
        }
        const extension = await this.store.installSiteExtensionSource(siteId, await (0, extension_manifest_1.createExtensionFromPath)(paths[0]), paths[0]);
        try {
            const loaded = await this.loadForSite(site, extension);
            extension.id = loaded.id;
            extension.name = loaded.name || extension.name;
            extension.version = loaded.version || extension.version;
        }
        catch (error) {
            extension.loadError = formatError(error);
        }
        return this.store.upsertExtension(siteId, extension);
    }
    async enableGlobal(extensionId) {
        const extension = this.store.getGlobalExtension(extensionId);
        if (!extension) {
            throw new Error("扩展程序不存在");
        }
        let loadError;
        try {
            await this.loadForAllSites(extension);
        }
        catch (error) {
            loadError = formatError(error);
        }
        return this.store.updateGlobalExtension(extensionId, {
            enabled: true,
            loadError,
        });
    }
    async disableGlobal(extensionId) {
        const extension = this.store.getGlobalExtension(extensionId);
        if (!extension) {
            throw new Error("扩展程序不存在");
        }
        await this.removeFromAllSites(extensionId);
        return this.store.updateGlobalExtension(extensionId, { enabled: false });
    }
    async uninstallGlobal(extensionId) {
        const extension = this.store.getGlobalExtension(extensionId);
        if (!extension) {
            throw new Error("扩展程序不存在");
        }
        await this.removeFromAllSites(extensionId);
        await this.store.deleteGlobalExtension(extensionId);
    }
    async enableSite(siteId, extensionId) {
        const site = this.store.getSite(siteId);
        const extension = site?.extensions.find((item) => item.id === extensionId);
        if (!site || !extension) {
            throw new Error("扩展程序不存在");
        }
        let loadError;
        try {
            await this.loadForSite(site, extension);
        }
        catch (error) {
            loadError = formatError(error);
        }
        return this.store.updateExtension(siteId, extensionId, {
            enabled: true,
            loadError,
        });
    }
    async disableSite(siteId, extensionId) {
        const site = this.store.getSite(siteId);
        const extension = site?.extensions.find((item) => item.id === extensionId);
        if (!site || !extension) {
            throw new Error("扩展程序不存在");
        }
        await this.removeFromSite(site, extensionId);
        return this.store.updateExtension(siteId, extensionId, { enabled: false });
    }
    async uninstallSite(siteId, extensionId) {
        const site = this.store.getSite(siteId);
        if (!site) {
            throw new Error("站点不存在");
        }
        await this.removeFromSite(site, extensionId);
        await this.store.deleteExtension(siteId, extensionId);
    }
    async loadForSite(site, extension) {
        let loaded;
        for (const siteSession of site.sessions) {
            const electronSession = (0, electron_session_manager_1.getElectronSession)(site.id, siteSession.id);
            this.bindSessionDownloads(`${site.id}:${siteSession.id}`, electronSession);
            loaded = await electronSession.loadExtension(extension.path, { allowFileAccess: true });
        }
        if (!loaded) {
            throw new Error("当前站点没有可加载扩展程序的会话");
        }
        return loaded;
    }
    async loadForDefaultProfile(extension) {
        const electronSession = (0, electron_session_manager_1.getDefaultProfileSession)();
        this.bindSessionDownloads("default-profile", electronSession);
        return electronSession.loadExtension(extension.path, { allowFileAccess: true });
    }
    async loadForAllSites(extension) {
        let loaded;
        for (const site of this.store.listSites()) {
            loaded = await this.loadForSite(site, extension);
        }
        return loaded;
    }
    async removeFromSite(site, extensionId) {
        for (const siteSession of site.sessions) {
            try {
                const electronSession = (0, electron_session_manager_1.getElectronSession)(site.id, siteSession.id);
                electronSession.removeExtension(extensionId);
            }
            catch {
                // 扩展程序不一定已加载到每个 session。
            }
        }
    }
    async removeFromAllSites(extensionId) {
        for (const site of this.store.listSites()) {
            await this.removeFromSite(site, extensionId);
        }
    }
    async pickExtensionPath() {
        const options = {
            title: "选择已解压的扩展程序目录",
            properties: ["openDirectory"],
        };
        const result = await electron_1.dialog.showOpenDialog(this.window, options);
        return result.canceled || result.filePaths.length === 0 ? undefined : result.filePaths;
    }
}
exports.ExtensionRuntime = ExtensionRuntime;
function formatError(error) {
    return error instanceof Error ? error.message : String(error);
}
