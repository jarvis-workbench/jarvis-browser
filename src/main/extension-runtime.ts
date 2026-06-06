import { BrowserWindow, OpenDialogOptions, dialog } from "electron";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Site, SiteExtension } from "../shared/types";
import { dataPaths } from "./data-paths";
import { getDefaultProfileSession, getElectronSession } from "./electron-session-manager";
import { createExtensionFromPath } from "./extension-manifest";
import type { MetadataStore } from "./store";
import { formatError } from "../shared/utils";

type BindSessionDownloads = (key: string, targetSession: Electron.Session) => void;
const electronUnsupportedExtensionPermissions = new Set(["cookies", "webNavigation"]);

export class ExtensionRuntime {
  constructor(
    private readonly window: BrowserWindow,
    private readonly store: MetadataStore,
    private readonly bindSessionDownloads: BindSessionDownloads,
  ) {}

  async loadEnabledForSite(site: Site) {
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

    const extension = await this.store.installGlobalExtensionSource(
      await createExtensionFromPath(paths[0]),
      paths[0],
    );
    try {
      const loaded = await this.loadForAllSites(extension);
      if (loaded) {
        extension.id = loaded.id;
        extension.name = loaded.name || extension.name;
        extension.version = loaded.version || extension.version;
      }
    } catch (error) {
      extension.loadError = formatError(error);
    }

    return this.store.upsertGlobalExtension(extension);
  }

  async installSiteUnpacked(siteId: string) {
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

    const extension = await this.store.installSiteExtensionSource(
      siteId,
      await createExtensionFromPath(paths[0]),
      paths[0],
    );
    try {
      const loaded = await this.loadForSite(site, extension);
      extension.id = loaded.id;
      extension.name = loaded.name || extension.name;
      extension.version = loaded.version || extension.version;
    } catch (error) {
      extension.loadError = formatError(error);
    }

    return this.store.upsertExtension(siteId, extension);
  }

  async enableGlobal(extensionId: string) {
    const extension = this.store.getGlobalExtension(extensionId);
    if (!extension) {
      throw new Error("扩展程序不存在");
    }

    let loadError: string | undefined;
    try {
      await this.loadForAllSites(extension);
    } catch (error) {
      loadError = formatError(error);
    }

    return this.store.updateGlobalExtension(extensionId, {
      enabled: true,
      loadError,
    });
  }

  async disableGlobal(extensionId: string) {
    const extension = this.store.getGlobalExtension(extensionId);
    if (!extension) {
      throw new Error("扩展程序不存在");
    }

    await this.removeFromAllSites(extensionId);
    return this.store.updateGlobalExtension(extensionId, { enabled: false });
  }

  async uninstallGlobal(extensionId: string) {
    const extension = this.store.getGlobalExtension(extensionId);
    if (!extension) {
      throw new Error("扩展程序不存在");
    }

    await this.removeFromAllSites(extensionId);
    await this.store.deleteGlobalExtension(extensionId);
  }

  async enableSite(siteId: string, extensionId: string) {
    const site = this.store.getSite(siteId);
    const extension = site?.extensions.find((item) => item.id === extensionId);
    if (!site || !extension) {
      throw new Error("扩展程序不存在");
    }

    let loadError: string | undefined;
    try {
      await this.loadForSite(site, extension);
    } catch (error) {
      loadError = formatError(error);
    }

    return this.store.updateExtension(siteId, extensionId, {
      enabled: true,
      loadError,
    });
  }

  async disableSite(siteId: string, extensionId: string) {
    const site = this.store.getSite(siteId);
    const extension = site?.extensions.find((item) => item.id === extensionId);
    if (!site || !extension) {
      throw new Error("扩展程序不存在");
    }

    await this.removeFromSite(site, extensionId);
    return this.store.updateExtension(siteId, extensionId, { enabled: false });
  }

  async uninstallSite(siteId: string, extensionId: string) {
    const site = this.store.getSite(siteId);
    if (!site) {
      throw new Error("站点不存在");
    }

    await this.removeFromSite(site, extensionId);
    await this.store.deleteExtension(siteId, extensionId);
  }

  private async loadForSite(site: Site, extension: SiteExtension) {
    let loaded: Electron.Extension | undefined;
    for (const siteSession of site.sessions) {
      const electronSession = getElectronSession(site.id, siteSession.id);
      this.bindSessionDownloads(`${site.id}:${siteSession.id}`, electronSession);
      loaded = await this.loadExtension(electronSession, extension);
    }

    if (!loaded) {
      throw new Error("当前站点没有可加载扩展程序的会话");
    }

    return loaded;
  }

  private async loadForDefaultProfile(extension: SiteExtension) {
    const electronSession = getDefaultProfileSession();
    this.bindSessionDownloads("default-profile", electronSession);
    return this.loadExtension(electronSession, extension);
  }

  private async loadForAllSites(extension: SiteExtension) {
    let loaded: Electron.Extension | undefined;
    for (const site of this.store.listSites()) {
      loaded = await this.loadForSite(site, extension);
    }

    return loaded;
  }

  private async loadExtension(targetSession: Electron.Session, extension: SiteExtension) {
    const loadPath = await prepareElectronExtensionLoadPath(extension);
    return targetSession.extensions.loadExtension(loadPath, { allowFileAccess: true });
  }

  private async removeFromSite(site: Site, extensionId: string) {
    for (const siteSession of site.sessions) {
      try {
        const electronSession = getElectronSession(site.id, siteSession.id);
        electronSession.removeExtension(extensionId);
      } catch {
        // 扩展程序不一定已加载到每个 session。
      }
    }
  }

  private async removeFromAllSites(extensionId: string) {
    for (const site of this.store.listSites()) {
      await this.removeFromSite(site, extensionId);
    }
  }

  private async pickExtensionPath() {
    const options: OpenDialogOptions = {
      title: "选择已解压的扩展程序目录",
      properties: ["openDirectory"],
    };
    const result = await dialog.showOpenDialog(this.window, options);
    return result.canceled || result.filePaths.length === 0 ? undefined : result.filePaths;
  }
}



async function prepareElectronExtensionLoadPath(extension: SiteExtension) {
  const manifest = JSON.parse(await readFile(join(extension.path, "manifest.json"), "utf8")) as {
    permissions?: string[];
  };
  const permissions = manifest.permissions ?? [];
  const filteredPermissions = permissions.filter((permission) => !electronUnsupportedExtensionPermissions.has(permission));
  if (filteredPermissions.length === permissions.length) {
    return extension.path;
  }

  const loadPath = join(dataPaths.runtime.extensionLoadRoot, extension.id);
  await rm(loadPath, { recursive: true, force: true });
  await mkdir(loadPath, { recursive: true });
  await cp(extension.path, loadPath, { recursive: true });
  await writeFile(
    join(loadPath, "manifest.json"),
    JSON.stringify({ ...manifest, permissions: filteredPermissions }, null, 2),
  );
  return loadPath;
}
