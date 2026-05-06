import { app } from "electron";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative } from "node:path";
import type { DownloadSettings, DownloadState, JarvisScript, Site, SiteExtension, SiteSession } from "../shared/types";
import { createSiteFaviconAssetUrl } from "./asset-protocol";
import { dataPaths } from "./data-paths";
import { createJarvisScriptFromPath } from "./jarvis-script/manifest";

type SiteIndexItem = Pick<Site, "id" | "title" | "name" | "url" | "faviconUrl" | "faviconPath" | "createdAt" | "updatedAt">;
type ProfileFile = {
  id: string;
  name: string;
  createdAt: string;
  downloadSettings?: Partial<DownloadSettings>;
};

const now = () => new Date().toISOString();

const createId = () => {
  if (globalThis.crypto?.randomUUID) {
    return globalThis.crypto.randomUUID();
  }

  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
};

const cleanText = (value: string, label: string) => {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`${label}不能为空`);
  }

  return trimmed;
};

export const normalizeHttpUrl = (rawUrl: string) => {
  const trimmed = cleanText(rawUrl, "网址");
  const withProtocol = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  const parsed = new URL(withProtocol);

  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("仅支持 http 和 https 网址");
  }

  return parsed.toString();
};

export class MetadataStore {
  private sites: Site[] = [];
  private globalExtensions: SiteExtension[] = [];
  private globalJarvisScripts: JarvisScript[] = [];
  private downloads: DownloadState[] = [];
  private profile: ProfileFile = createDefaultProfile();
  private downloadSettings: DownloadSettings = createDefaultDownloadSettings();
  private loaded = false;
  private writeQueue = Promise.resolve();

  async load() {
    if (this.loaded) {
      return;
    }

    await ensureBaseDirectories();
    this.profile = await readJson<ProfileFile>(dataPaths.profileFile, createDefaultProfile());
    this.downloadSettings = normalizeDownloadSettings(this.profile.downloadSettings);
    this.globalExtensions = await readJson<SiteExtension[]>(dataPaths.global.extensionsIndexFile, []);
    this.globalJarvisScripts = await readJson<JarvisScript[]>(dataPaths.global.jarvisScriptsIndexFile, []);
    this.downloads = (await readJson<DownloadState[]>(dataPaths.global.downloadsFile, []))
      .map(normalizeDownloadState)
      .filter((download) => download.id && download.filename);
    this.sites = await this.loadSites();
    await this.persistLoadedState();
    this.loaded = true;
  }

  listSites() {
    return this.sites.map(toRendererSite);
  }

  listDownloads() {
    return structuredClone(this.downloads);
  }

  getDownload(downloadId: string) {
    return this.downloads.find((download) => download.id === downloadId);
  }

  getDownloadSettings() {
    return structuredClone(this.downloadSettings);
  }

  async updateDownloadSettings(input: Partial<DownloadSettings>) {
    this.downloadSettings = normalizeDownloadSettings({
      ...this.downloadSettings,
      ...input,
    });
    this.profile = {
      ...this.profile,
      downloadSettings: this.downloadSettings,
    };
    await this.persistProfile();
    return this.getDownloadSettings();
  }

  listGlobalExtensions() {
    return structuredClone(this.globalExtensions);
  }

  listGlobalJarvisScripts() {
    return structuredClone(this.globalJarvisScripts);
  }

  listSiteJarvisScripts(siteId: string) {
    return structuredClone(this.requireSite(siteId).jarvisScripts);
  }

  getSite(siteId: string) {
    return this.sites.find((site) => site.id === siteId);
  }

  getSession(siteId: string, sessionId: string) {
    return this.getSite(siteId)?.sessions.find((session) => session.id === sessionId);
  }

  getGlobalExtension(extensionId: string) {
    return this.globalExtensions.find((extension) => extension.id === extensionId);
  }

  async addSite(input: { url: string; title?: string }) {
    const timestamp = now();
    const url = normalizeHttpUrl(input.url);
    this.assertUniqueSiteUrl(url);
    const title = input.title?.trim() ? cleanText(input.title, "站点名称") : "";
    const site: Site = {
      id: createId(),
      title,
      name: title,
      url,
      sessions: [],
      extensions: [],
      jarvisScripts: [],
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    this.sites.push(site);
    await this.enqueue(async () => {
      await this.writeSite(site);
      await this.writeSessionsIndex(site);
      await this.writeSiteExtensionsIndex(site);
      await this.writeSitesIndex();
    });
    return structuredClone(site);
  }

  async updateSite(siteId: string, input: { url?: string; title?: string }) {
    const site = this.requireSite(siteId);

    if (input.url !== undefined) {
      const url = normalizeHttpUrl(input.url);
      this.assertUniqueSiteUrl(url, siteId);
      site.url = url;
    }

    if (input.title !== undefined) {
      site.title = input.title.trim() ? cleanText(input.title, "站点名称") : "";
      site.name = site.title;
    }

    site.updatedAt = now();
    await this.persistSiteAndIndex(site);
    return structuredClone(site);
  }

  async updateSiteMetadata(siteId: string, input: { faviconUrl?: string; faviconPath?: string }) {
    const site = this.requireSite(siteId);

    if (input.faviconUrl !== undefined) {
      site.faviconUrl = input.faviconUrl;
    }

    if (input.faviconPath !== undefined) {
      site.faviconPath = input.faviconPath;
    }

    site.updatedAt = now();
    await this.persistSiteAndIndex(site);
    return structuredClone(site);
  }

  async fillMissingSiteTitle(siteId: string, title: string) {
    const site = this.requireSite(siteId);
    if (site.title.trim() || !title.trim()) {
      return structuredClone(site);
    }

    site.title = cleanText(title, "站点名称");
    site.name = site.title;
    site.updatedAt = now();
    await this.persistSiteAndIndex(site);
    return structuredClone(site);
  }

  async deleteSite(siteId: string) {
    const nextSites = this.sites.filter((site) => site.id !== siteId);
    if (nextSites.length === this.sites.length) {
      throw new Error("站点不存在");
    }

    this.sites = nextSites;
    await this.enqueue(async () => {
      await rm(dataPaths.sites.siteRoot(siteId), { recursive: true, force: true });
      await this.writeSitesIndex();
    });
  }

  async addSession(siteId: string, input: { name: string }) {
    const site = this.requireSite(siteId);
    const timestamp = now();
    const sessionName = input.name.trim() ? cleanText(input.name, "会话名称") : nextSessionName(site);
    this.assertUniqueSessionName(site, sessionName);
    const session: SiteSession = {
      id: createId(),
      siteId,
      name: sessionName,
      lastUrl: site.url,
      url: site.url,
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    site.sessions.push(session);
    site.updatedAt = timestamp;
    await this.enqueue(async () => {
      await this.writeSession(site, session);
      await this.writeSite(site);
      await this.writeSitesIndex();
    });
    return structuredClone(session);
  }

  async renameSession(siteId: string, sessionId: string, name: string) {
    const { site, session } = this.requireSession(siteId, sessionId);
    const timestamp = now();
    const sessionName = cleanText(name, "会话名称");
    this.assertUniqueSessionName(site, sessionName, sessionId);
    session.name = sessionName;
    session.updatedAt = timestamp;
    site.updatedAt = timestamp;
    await this.enqueue(async () => {
      await this.writeSession(site, session);
      await this.writeSite(site);
      await this.writeSitesIndex();
    });
    return structuredClone(session);
  }

  async deleteSession(siteId: string, sessionId: string) {
    const site = this.requireSite(siteId);
    const nextSessions = site.sessions.filter((session) => session.id !== sessionId);
    if (nextSessions.length === site.sessions.length) {
      throw new Error("会话不存在");
    }

    site.sessions = nextSessions;
    site.updatedAt = now();
    await this.enqueue(async () => {
      await rm(dataPaths.sites.sessionRoot(siteId, sessionId), { recursive: true, force: true });
      await this.writeSite(site);
      await this.writeSessionsIndex(site);
      await this.writeSitesIndex();
    });
  }

  async upsertExtension(siteId: string, extension: SiteExtension) {
    const site = this.requireSite(siteId);
    site.extensions = [
      ...site.extensions.filter((item) => item.id !== extension.id),
      extension,
    ];
    site.updatedAt = now();
    await this.persistSiteExtensions(site);
    await this.persistSiteAndIndex(site);
    return structuredClone(extension);
  }

  async upsertGlobalExtension(extension: SiteExtension) {
    this.globalExtensions = [
      ...this.globalExtensions.filter((item) => item.id !== extension.id),
      extension,
    ];
    await this.persistGlobalExtensions();
    return structuredClone(extension);
  }

  async updateExtension(siteId: string, extensionId: string, input: Partial<SiteExtension>) {
    const site = this.requireSite(siteId);
    const extension = site.extensions.find((item) => item.id === extensionId);
    if (!extension) {
      throw new Error("插件不存在");
    }

    Object.assign(extension, input, { updatedAt: now() });
    site.updatedAt = now();
    await this.persistSiteExtensions(site);
    await this.persistSiteAndIndex(site);
    return structuredClone(extension);
  }

  async updateGlobalExtension(extensionId: string, input: Partial<SiteExtension>) {
    const extension = this.globalExtensions.find((item) => item.id === extensionId);
    if (!extension) {
      throw new Error("插件不存在");
    }

    Object.assign(extension, input, { updatedAt: now() });
    await this.persistGlobalExtensions();
    return structuredClone(extension);
  }

  async deleteExtension(siteId: string, extensionId: string) {
    const site = this.requireSite(siteId);
    const nextExtensions = site.extensions.filter((extension) => extension.id !== extensionId);
    if (nextExtensions.length === site.extensions.length) {
      throw new Error("插件不存在");
    }

    site.extensions = nextExtensions;
    site.updatedAt = now();
    await this.enqueue(async () => {
      await rm(dataPaths.sites.extensionInstallDir(siteId, extensionId), { recursive: true, force: true });
      await this.writeSite(site);
      await this.writeSiteExtensionsIndex(site);
      await this.writeSitesIndex();
    });
  }

  async deleteGlobalExtension(extensionId: string) {
    const nextExtensions = this.globalExtensions.filter((extension) => extension.id !== extensionId);
    if (nextExtensions.length === this.globalExtensions.length) {
      throw new Error("插件不存在");
    }

    this.globalExtensions = nextExtensions;
    await this.enqueue(async () => {
      await rm(dataPaths.global.extensionInstallDir(extensionId), { recursive: true, force: true });
      await this.writeGlobalExtensionsIndex();
    });
  }

  async installGlobalJarvisScriptSource(sourcePath: string) {
    const script = await createJarvisScriptFromPath(sourcePath, "global");
    const existing = this.globalJarvisScripts.find((item) => item.id === script.id);
    if (existing) {
      script.createdAt = existing.createdAt;
    }

    await this.installJarvisScriptSource(script, sourcePath, dataPaths.global.jarvisScriptSourceDir(script.id), dataPaths.global.jarvisScriptManifestFile(script.id));
    this.globalJarvisScripts = [
      ...this.globalJarvisScripts.filter((item) => item.id !== script.id),
      script,
    ];
    await this.persistGlobalJarvisScripts();
    return structuredClone(script);
  }

  async installSiteJarvisScriptSource(siteId: string, sourcePath: string) {
    const site = this.requireSite(siteId);
    const script = await createJarvisScriptFromPath(sourcePath, "site", siteId);
    const existing = site.jarvisScripts.find((item) => item.id === script.id);
    if (existing) {
      script.createdAt = existing.createdAt;
    }

    await this.installJarvisScriptSource(script, sourcePath, dataPaths.sites.jarvisScriptSourceDir(siteId, script.id), dataPaths.sites.jarvisScriptManifestFile(siteId, script.id));
    site.jarvisScripts = [
      ...site.jarvisScripts.filter((item) => item.id !== script.id),
      script,
    ];
    site.updatedAt = now();
    await this.persistSiteJarvisScripts(site);
    await this.persistSiteAndIndex(site);
    return structuredClone(script);
  }

  async updateGlobalJarvisScript(scriptId: string, input: { runtimeState?: Partial<JarvisScript["runtimeState"]> }) {
    const script = this.globalJarvisScripts.find((item) => item.id === scriptId);
    if (!script) {
      throw new Error("Jarvis Script 不存在");
    }

    updateJarvisScript(script, input);
    await this.enqueue(async () => {
      await writeJson(dataPaths.global.jarvisScriptManifestFile(script.id), script);
      await this.writeGlobalJarvisScriptsIndex();
    });
    return structuredClone(script);
  }

  async updateSiteJarvisScript(siteId: string, scriptId: string, input: { runtimeState?: Partial<JarvisScript["runtimeState"]> }) {
    const site = this.requireSite(siteId);
    const script = site.jarvisScripts.find((item) => item.id === scriptId);
    if (!script) {
      throw new Error("Jarvis Script 不存在");
    }

    updateJarvisScript(script, input);
    site.updatedAt = now();
    await this.enqueue(async () => {
      await writeJson(dataPaths.sites.jarvisScriptManifestFile(site.id, script.id), script);
      await this.writeSiteJarvisScriptsIndex(site);
      await this.writeSite(site);
      await this.writeSitesIndex();
    });
    return structuredClone(script);
  }

  async deleteGlobalJarvisScript(scriptId: string) {
    const nextScripts = this.globalJarvisScripts.filter((script) => script.id !== scriptId);
    if (nextScripts.length === this.globalJarvisScripts.length) {
      throw new Error("Jarvis Script 不存在");
    }

    this.globalJarvisScripts = nextScripts;
    await this.enqueue(async () => {
      await rm(dataPaths.global.jarvisScriptInstallDir(scriptId), { recursive: true, force: true });
      await this.writeGlobalJarvisScriptsIndex();
    });
  }

  async deleteSiteJarvisScript(siteId: string, scriptId: string) {
    const site = this.requireSite(siteId);
    const nextScripts = site.jarvisScripts.filter((script) => script.id !== scriptId);
    if (nextScripts.length === site.jarvisScripts.length) {
      throw new Error("Jarvis Script 不存在");
    }

    site.jarvisScripts = nextScripts;
    site.updatedAt = now();
    await this.enqueue(async () => {
      await rm(dataPaths.sites.jarvisScriptInstallDir(siteId, scriptId), { recursive: true, force: true });
      await this.writeSite(site);
      await this.writeSiteJarvisScriptsIndex(site);
      await this.writeSitesIndex();
    });
  }

  async upsertDownload(download: DownloadState) {
    const normalized = normalizeDownloadState(download);
    this.downloads = [
      normalized,
      ...this.downloads.filter((item) => item.id !== normalized.id),
    ].slice(0, 200);
    await this.persistDownloads();
    return structuredClone(normalized);
  }

  async removeDownload(downloadId: string) {
    const nextDownloads = this.downloads.filter((download) => download.id !== downloadId);
    if (nextDownloads.length === this.downloads.length) {
      throw new Error("下载记录不存在");
    }

    this.downloads = nextDownloads;
    await this.persistDownloads();
  }

  async clearDownloads() {
    this.downloads = [];
    await this.persistDownloads();
  }

  async installGlobalExtensionSource(extension: SiteExtension, sourcePath: string) {
    const sourceDir = dataPaths.global.extensionSourceDir(extension.id);
    await replaceDirectory(sourcePath, sourceDir);
    extension.icon = remapInstalledPath(sourcePath, sourceDir, extension.icon);
    extension.path = sourceDir;
    await writeJson(dataPaths.global.extensionManifestFile(extension.id), extension);
    return extension;
  }

  async installSiteExtensionSource(siteId: string, extension: SiteExtension, sourcePath: string) {
    this.requireSite(siteId);
    const sourceDir = dataPaths.sites.extensionSourceDir(siteId, extension.id);
    await replaceDirectory(sourcePath, sourceDir);
    extension.icon = remapInstalledPath(sourcePath, sourceDir, extension.icon);
    extension.path = sourceDir;
    await writeJson(dataPaths.sites.extensionManifestFile(siteId, extension.id), extension);
    return extension;
  }

  private async loadSites() {
    const index = await readJson<SiteIndexItem[]>(dataPaths.sites.indexFile, []);
    const sites: Site[] = [];

    for (const item of index) {
      const site = await readJson<Site | undefined>(dataPaths.sites.siteFile(item.id), undefined);
      if (!site) {
        continue;
      }

      site.sessions = await this.loadSessions(site.id);
      site.extensions = await readJson<SiteExtension[]>(dataPaths.sites.extensionsIndexFile(site.id), []);
      site.jarvisScripts = await readJson<JarvisScript[]>(dataPaths.sites.jarvisScriptsIndexFile(site.id), []);
      sites.push(site);
    }

    return sites;
  }

  private async loadSessions(siteId: string) {
    const sessions = await readJson<SiteSession[]>(dataPaths.sites.sessionsIndexFile(siteId), []);
    return sessions.map((session) => ({
      ...session,
      siteId,
    }));
  }

  private async persistSiteAndIndex(site: Site) {
    await this.enqueue(async () => {
      await this.writeSite(site);
      await this.writeSitesIndex();
    });
  }

  private async persistSiteExtensions(site: Site) {
    await this.enqueue(async () => {
      await this.writeSiteExtensionsIndex(site);
    });
  }

  private async persistGlobalExtensions() {
    await this.enqueue(async () => {
      await this.writeGlobalExtensionsIndex();
    });
  }

  private async persistSiteJarvisScripts(site: Site) {
    await this.enqueue(async () => {
      await this.writeSiteJarvisScriptsIndex(site);
    });
  }

  private async persistGlobalJarvisScripts() {
    await this.enqueue(async () => {
      await this.writeGlobalJarvisScriptsIndex();
    });
  }

  private async persistDownloads() {
    await this.enqueue(async () => {
      await writeJson(dataPaths.global.downloadsFile, this.downloads);
    });
  }

  private async persistProfile() {
    await this.enqueue(async () => {
      await writeJson(dataPaths.profileFile, this.profile);
    });
  }

  private async persistLoadedState() {
    await this.enqueue(async () => {
      await this.writeSitesIndex();
      await this.writeGlobalExtensionsIndex();
      await this.writeGlobalJarvisScriptsIndex();
      for (const site of this.sites) {
        await this.writeSite(site);
        await this.writeSessionsIndex(site);
        await this.writeSiteExtensionsIndex(site);
        await this.writeSiteJarvisScriptsIndex(site);
        for (const siteSession of site.sessions) {
          await writeJson(dataPaths.sites.sessionFile(site.id, siteSession.id), siteSession);
        }
      }
    });
  }

  private async writeSite(site: Site) {
    await mkdir(dataPaths.sites.siteRoot(site.id), { recursive: true });
    await mkdir(dataPaths.sites.faviconRoot(site.id), { recursive: true });
    await mkdir(dataPaths.sites.extensionsRoot(site.id), { recursive: true });
    await mkdir(dataPaths.sites.jarvisScriptsRoot(site.id), { recursive: true });
    await mkdir(dataPaths.sites.sessionsRoot(site.id), { recursive: true });
    await writeJson(dataPaths.sites.siteFile(site.id), site);
  }

  private async writeSession(site: Site, session: SiteSession) {
    await mkdir(dataPaths.sites.sessionRoot(site.id, session.id), { recursive: true });
    await mkdir(dataPaths.sites.sessionDownloadsDir(site.id, session.id), { recursive: true });
    await writeJson(dataPaths.sites.sessionFile(site.id, session.id), session);
    await this.writeSessionsIndex(site);
  }

  private async writeSitesIndex() {
    await writeJson(dataPaths.sites.indexFile, this.sites.map(toSiteIndexItem));
  }

  private async writeSessionsIndex(site: Site) {
    await mkdir(dataPaths.sites.sessionsRoot(site.id), { recursive: true });
    await writeJson(dataPaths.sites.sessionsIndexFile(site.id), site.sessions);
  }

  private async writeSiteExtensionsIndex(site: Site) {
    await mkdir(dataPaths.sites.extensionsRoot(site.id), { recursive: true });
    await writeJson(dataPaths.sites.extensionsIndexFile(site.id), site.extensions);
  }

  private async writeSiteJarvisScriptsIndex(site: Site) {
    await mkdir(dataPaths.sites.jarvisScriptsRoot(site.id), { recursive: true });
    await writeJson(dataPaths.sites.jarvisScriptsIndexFile(site.id), site.jarvisScripts);
  }

  private async writeGlobalExtensionsIndex() {
    await mkdir(dataPaths.global.extensionsRoot, { recursive: true });
    await writeJson(dataPaths.global.extensionsIndexFile, this.globalExtensions);
  }

  private async writeGlobalJarvisScriptsIndex() {
    await mkdir(dataPaths.global.jarvisScriptsRoot, { recursive: true });
    await writeJson(dataPaths.global.jarvisScriptsIndexFile, this.globalJarvisScripts);
  }

  private async installJarvisScriptSource(script: JarvisScript, sourcePath: string, sourceDir: string, manifestFile: string) {
    await replaceDirectory(sourcePath, sourceDir);
    script.path = sourceDir;
    script.updatedAt = now();
    await writeJson(manifestFile, script);
  }

  private requireSite(siteId: string) {
    const site = this.getSite(siteId);
    if (!site) {
      throw new Error("站点不存在");
    }

    return site;
  }

  private requireSession(siteId: string, sessionId: string) {
    const site = this.requireSite(siteId);
    const session = site.sessions.find((item) => item.id === sessionId);
    if (!session) {
      throw new Error("会话不存在");
    }

    return { site, session };
  }

  private assertUniqueSessionName(site: Site, sessionName: string, exceptSessionId?: string) {
    const exists = site.sessions.some((session) => session.id !== exceptSessionId && session.name === sessionName);
    if (exists) {
      throw new Error("同一站点下已存在同名会话");
    }
  }

  private assertUniqueSiteUrl(url: string, exceptSiteId?: string) {
    const exists = this.sites.some((site) => site.id !== exceptSiteId && site.url === url);
    if (exists) {
      throw new Error("该站点地址已存在");
    }
  }

  private async enqueue(work: () => Promise<void>) {
    this.writeQueue = this.writeQueue.then(work);
    await this.writeQueue;
  }
}

async function ensureBaseDirectories() {
  await mkdir(dataPaths.userRoot, { recursive: true });
  await mkdir(dataPaths.global.root, { recursive: true });
  await mkdir(dataPaths.global.extensionsRoot, { recursive: true });
  await mkdir(dataPaths.global.jarvisScriptsRoot, { recursive: true });
  await mkdir(dataPaths.sites.root, { recursive: true });
  await mkdir(dataPaths.runtime.userData, { recursive: true });
  await mkdir(dataPaths.runtime.sessionData, { recursive: true });
  await writeJsonIfMissing(dataPaths.profileFile, createDefaultProfile());
  await writeJsonIfMissing(dataPaths.global.metadataFile, {
    userId: "default",
    updatedAt: now(),
  });
  await writeJsonIfMissing(dataPaths.global.downloadsFile, []);
  await writeJsonIfMissing(dataPaths.global.extensionsIndexFile, []);
  await writeJsonIfMissing(dataPaths.global.jarvisScriptsIndexFile, []);
  await writeJsonIfMissing(dataPaths.sites.indexFile, []);
}

function createDefaultProfile(): ProfileFile {
  return {
    id: "default",
    name: "default",
    createdAt: now(),
    downloadSettings: createDefaultDownloadSettings(),
  };
}

function createDefaultDownloadSettings(): DownloadSettings {
  return {
    downloadPath: app.getPath("downloads"),
    askWhereToSaveBeforeDownloading: false,
  };
}

function normalizeDownloadSettings(input?: Partial<DownloadSettings>): DownloadSettings {
  const fallback = createDefaultDownloadSettings();
  return {
    downloadPath: typeof input?.downloadPath === "string" && input.downloadPath.trim()
      ? input.downloadPath
      : fallback.downloadPath,
    askWhereToSaveBeforeDownloading: Boolean(input?.askWhereToSaveBeforeDownloading),
  };
}

function normalizeDownloadState(input: Partial<DownloadState>): DownloadState {
  return {
    id: input.id ?? "",
    filename: input.filename ?? "",
    url: input.url ?? "",
    savePath: input.savePath ?? "",
    mimeType: input.mimeType ?? "",
    receivedBytes: input.receivedBytes ?? 0,
    totalBytes: input.totalBytes ?? 0,
    state: input.state ?? "interrupted",
    startTime: input.startTime ?? Date.now(),
    endTime: input.endTime,
    paused: Boolean(input.paused),
    canResume: Boolean(input.canResume),
    speedBytesPerSecond: input.speedBytesPerSecond ?? 0,
    errorText: input.errorText,
  };
}

function toSiteIndexItem(site: Site): SiteIndexItem {
  return {
    id: site.id,
    title: site.title,
    name: site.name,
    url: site.url,
    faviconUrl: site.faviconUrl,
    faviconPath: site.faviconPath,
    createdAt: site.createdAt,
    updatedAt: site.updatedAt,
  };
}

function toRendererSite(site: Site) {
  const nextSite = structuredClone(site);
  if (nextSite.faviconPath) {
    nextSite.faviconPath = createSiteFaviconAssetUrl(site.id);
  }

  return nextSite;
}

function nextSessionName(site: Site) {
  let index = site.sessions.length + 1;
  while (site.sessions.some((session) => session.name === `会话 ${index}`)) {
    index += 1;
  }

  return `会话 ${index}`;
}

function updateJarvisScript(script: JarvisScript, input: { runtimeState?: Partial<JarvisScript["runtimeState"]> }) {
  if (input.runtimeState) {
    script.runtimeState = {
      ...script.runtimeState,
      ...input.runtimeState,
    };
  }

  script.updatedAt = now();
}

async function readJson<T>(filePath: string, fallback: T) {
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return fallback;
    }

    throw error;
  }
}

async function writeJson(filePath: string, value: unknown) {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function writeJsonIfMissing(filePath: string, value: unknown) {
  try {
    await readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
    await writeJson(filePath, value);
  }
}

async function replaceDirectory(sourcePath: string, targetPath: string) {
  await rm(targetPath, { recursive: true, force: true });
  await mkdir(dirname(targetPath), { recursive: true });
  await cp(sourcePath, targetPath, { recursive: true, force: true });
}

function remapInstalledPath(sourceRoot: string, targetRoot: string, sourceFile?: string) {
  if (!sourceFile || !isAbsolute(sourceFile)) {
    return sourceFile;
  }

  const childPath = relative(sourceRoot, sourceFile);
  if (childPath.startsWith("..")) {
    return sourceFile;
  }

  return join(targetRoot, childPath);
}
