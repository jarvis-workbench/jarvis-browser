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
    clearExtensionLoadCache(extension.id);
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
    clearExtensionLoadCache(extension.id);
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
    clearExtensionLoadCache(extensionId);
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
    clearExtensionLoadCache(extensionId);
    const extension = this.store.getGlobalExtension(extensionId);
    if (!extension) {
      throw new Error("扩展程序不存在");
    }

    await this.removeFromAllSites(extensionId);
    return this.store.updateGlobalExtension(extensionId, { enabled: false });
  }

  async uninstallGlobal(extensionId: string) {
    clearExtensionLoadCache(extensionId);
    const extension = this.store.getGlobalExtension(extensionId);
    if (!extension) {
      throw new Error("扩展程序不存在");
    }

    await this.removeFromAllSites(extensionId);
    await this.store.deleteGlobalExtension(extensionId);
  }

  async enableSite(siteId: string, extensionId: string) {
    clearExtensionLoadCache(extensionId);
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
    clearExtensionLoadCache(extensionId);
    const site = this.store.getSite(siteId);
    const extension = site?.extensions.find((item) => item.id === extensionId);
    if (!site || !extension) {
      throw new Error("扩展程序不存在");
    }

    await this.removeFromSite(site, extensionId);
    return this.store.updateExtension(siteId, extensionId, { enabled: false });
  }

  async uninstallSite(siteId: string, extensionId: string) {
    clearExtensionLoadCache(extensionId);
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

  async ensureLoadedForSession(siteId: string, sessionId: string, extension: SiteExtension) {
    const electronSession = getElectronSession(siteId, sessionId);
    this.bindSessionDownloads(`${siteId}:${sessionId}`, electronSession);
    const existing = findLoadedExtension(electronSession, extension);
    if (existing) {
      return existing;
    }
    return this.loadExtension(electronSession, extension);
  }

  private async loadExtension(targetSession: Electron.Session, extension: SiteExtension) {
    const loadPath = await prepareElectronExtensionLoadPath(extension);
    const existing = findLoadedExtension(targetSession, extension, loadPath);
    if (existing) {
      return existing;
    }

    try {
      return await targetSession.extensions.loadExtension(loadPath, { allowFileAccess: true });
    } catch (error) {
      const loaded = findLoadedExtension(targetSession, extension, loadPath);
      if (loaded) {
        return loaded;
      }
      throw error;
    }
  }

  private async removeFromSite(site: Site, extensionId: string) {
    for (const siteSession of site.sessions) {
      try {
        const electronSession = getElectronSession(site.id, siteSession.id);
        const extensionsApi = electronSession.extensions as Electron.Session["extensions"] & {
          removeExtension?: (id: string) => void;
        };
        if (typeof extensionsApi?.removeExtension === "function") {
          extensionsApi.removeExtension(extensionId);
        } else {
          (electronSession as Electron.Session & { removeExtension?: (id: string) => void }).removeExtension?.(extensionId);
        }
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



const extensionLoadPromises = new Map<string, Promise<string>>();

export function clearExtensionLoadCache(extensionId: string) {
  extensionLoadPromises.delete(extensionId);
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

  const existingPromise = extensionLoadPromises.get(extension.id);
  if (existingPromise) {
    return existingPromise;
  }

  const promise = (async () => {
    const loadPath = join(dataPaths.runtime.extensionLoadRoot, extension.id);
    await rm(loadPath, { recursive: true, force: true });
    await mkdir(loadPath, { recursive: true });
    await cp(extension.path, loadPath, { recursive: true });
    await writeFile(
      join(loadPath, "manifest.json"),
      JSON.stringify({ ...manifest, permissions: filteredPermissions }, null, 2),
    );
    return loadPath;
  })();

  extensionLoadPromises.set(extension.id, promise);
  try {
    return await promise;
  } catch (error) {
    extensionLoadPromises.delete(extension.id);
    throw error;
  }
}


function listSessionExtensions(targetSession: Electron.Session) {
  const extensionsApi = targetSession.extensions as Electron.Session["extensions"] & {
    getAllExtensions?: () => Electron.Extension[];
  };
  if (typeof extensionsApi?.getAllExtensions === "function") {
    return extensionsApi.getAllExtensions();
  }

  const legacySession = targetSession as Electron.Session & {
    getAllExtensions?: () => Electron.Extension[];
  };
  if (typeof legacySession.getAllExtensions === "function") {
    return legacySession.getAllExtensions();
  }

  return [];
}

export function findLoadedExtension(
  targetSession: Electron.Session,
  extension: SiteExtension,
  loadPath?: string,
) {
  const loaded = listSessionExtensions(targetSession);
  const candidates = [extension.path, loadPath].filter((value): value is string => Boolean(value));
  return loaded.find((item) => {
    if (item.id === extension.id) {
      return true;
    }
    if (candidates.some((candidate) => item.path === candidate)) {
      return true;
    }
    if (extension.path && item.path && pathsLooselyMatch(extension.path, item.path)) {
      return true;
    }
    if (loadPath && item.path && pathsLooselyMatch(loadPath, item.path)) {
      return true;
    }
    // Fallback for remapped load directories: same extension name + version.
    if (item.name && extension.name && item.name === extension.name) {
      if (!item.version || !extension.version || item.version === extension.version) {
        return true;
      }
    }
    return false;
  });
}

function pathsLooselyMatch(left: string, right: string) {
  if (left === right) {
    return true;
  }
  const normalize = (value: string) => value.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  const a = normalize(left);
  const b = normalize(right);
  return a === b || a.endsWith(b) || b.endsWith(a);
}
