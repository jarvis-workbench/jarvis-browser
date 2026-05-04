import { dialog, type BrowserWindow, type OpenDialogOptions } from "electron";
import type { JarvisScript } from "../../shared/types";
import type { MetadataStore } from "../store";
import type { JarvisScriptRuntime } from "./runtime";

export class JarvisScriptManager {
  constructor(
    private readonly window: BrowserWindow,
    private readonly store: MetadataStore,
    private readonly runtime: JarvisScriptRuntime,
  ) {}

  async installGlobal() {
    const sourcePath = await this.pickScriptPath();
    if (!sourcePath) {
      return undefined;
    }

    const script = await this.store.installGlobalJarvisScriptSource(sourcePath);
    await this.runtime.refreshUserScriptWorkers();
    return script;
  }

  async installSite(siteId: string) {
    const sourcePath = await this.pickScriptPath();
    if (!sourcePath) {
      return undefined;
    }

    const script = await this.store.installSiteJarvisScriptSource(siteId, sourcePath);
    await this.runtime.refreshUserScriptWorkers();
    return script;
  }

  async enableGlobal(scriptId: string) {
    const script = await this.store.updateGlobalJarvisScript(scriptId, {
      runtimeState: { enabled: true, loadError: undefined },
    });
    await this.runtime.refreshUserScriptWorkers();
    return script;
  }

  async disableGlobal(scriptId: string) {
    const script = await this.store.updateGlobalJarvisScript(scriptId, {
      runtimeState: { enabled: false, lastStoppedAt: new Date().toISOString() },
    });
    this.runtime.stopScript(script);
    await this.runtime.refreshUserScriptWorkers();
    return script;
  }

  async uninstallGlobal(scriptId: string) {
    const script = this.store.listGlobalJarvisScripts().find((item) => item.id === scriptId);
    if (script) {
      this.runtime.stopScript(script);
    }
    await this.store.deleteGlobalJarvisScript(scriptId);
    await this.runtime.refreshUserScriptWorkers();
  }

  async enableSite(siteId: string, scriptId: string) {
    const script = await this.store.updateSiteJarvisScript(siteId, scriptId, {
      runtimeState: { enabled: true, loadError: undefined },
    });
    await this.runtime.refreshUserScriptWorkers();
    return script;
  }

  async disableSite(siteId: string, scriptId: string) {
    const script = await this.store.updateSiteJarvisScript(siteId, scriptId, {
      runtimeState: { enabled: false, lastStoppedAt: new Date().toISOString() },
    });
    this.runtime.stopScript(script);
    await this.runtime.refreshUserScriptWorkers();
    return script;
  }

  async uninstallSite(siteId: string, scriptId: string) {
    const script = this.store.listSiteJarvisScripts(siteId).find((item) => item.id === scriptId);
    if (script) {
      this.runtime.stopScript(script);
    }
    await this.store.deleteSiteJarvisScript(siteId, scriptId);
    await this.runtime.refreshUserScriptWorkers();
  }

  private async pickScriptPath() {
    const options: OpenDialogOptions = {
      title: "选择 Jarvis Script 目录",
      properties: ["openDirectory"],
    };
    const result = await dialog.showOpenDialog(this.window, options);
    return result.canceled || result.filePaths.length === 0 ? undefined : result.filePaths[0];
  }
}
