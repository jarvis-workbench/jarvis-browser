"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.JarvisScriptManager = void 0;
const electron_1 = require("electron");
class JarvisScriptManager {
    window;
    store;
    runtime;
    constructor(window, store, runtime) {
        this.window = window;
        this.store = store;
        this.runtime = runtime;
    }
    async installGlobal() {
        const sourcePath = await this.pickScriptPath();
        if (!sourcePath) {
            return undefined;
        }
        const script = await this.store.installGlobalJarvisScriptSource(sourcePath);
        await this.runtime.refreshUserScriptWorkers();
        return script;
    }
    async installSite(siteId) {
        const sourcePath = await this.pickScriptPath();
        if (!sourcePath) {
            return undefined;
        }
        const script = await this.store.installSiteJarvisScriptSource(siteId, sourcePath);
        await this.runtime.refreshUserScriptWorkers();
        return script;
    }
    async enableGlobal(scriptId) {
        const script = await this.store.updateGlobalJarvisScript(scriptId, {
            runtimeState: { enabled: true, loadError: undefined },
        });
        await this.runtime.refreshUserScriptWorkers();
        return script;
    }
    async disableGlobal(scriptId) {
        const script = await this.store.updateGlobalJarvisScript(scriptId, {
            runtimeState: { enabled: false, lastStoppedAt: new Date().toISOString() },
        });
        this.runtime.stopScript(script);
        await this.runtime.refreshUserScriptWorkers();
        return script;
    }
    async uninstallGlobal(scriptId) {
        const script = this.store.listGlobalJarvisScripts().find((item) => item.id === scriptId);
        if (script) {
            this.runtime.stopScript(script);
        }
        await this.store.deleteGlobalJarvisScript(scriptId);
        await this.runtime.refreshUserScriptWorkers();
    }
    async enableSite(siteId, scriptId) {
        const script = await this.store.updateSiteJarvisScript(siteId, scriptId, {
            runtimeState: { enabled: true, loadError: undefined },
        });
        await this.runtime.refreshUserScriptWorkers();
        return script;
    }
    async disableSite(siteId, scriptId) {
        const script = await this.store.updateSiteJarvisScript(siteId, scriptId, {
            runtimeState: { enabled: false, lastStoppedAt: new Date().toISOString() },
        });
        this.runtime.stopScript(script);
        await this.runtime.refreshUserScriptWorkers();
        return script;
    }
    async uninstallSite(siteId, scriptId) {
        const script = this.store.listSiteJarvisScripts(siteId).find((item) => item.id === scriptId);
        if (script) {
            this.runtime.stopScript(script);
        }
        await this.store.deleteSiteJarvisScript(siteId, scriptId);
        await this.runtime.refreshUserScriptWorkers();
    }
    async pickScriptPath() {
        const options = {
            title: "选择 Jarvis Script 目录",
            properties: ["openDirectory"],
        };
        const result = await electron_1.dialog.showOpenDialog(this.window, options);
        return result.canceled || result.filePaths.length === 0 ? undefined : result.filePaths[0];
    }
}
exports.JarvisScriptManager = JarvisScriptManager;
