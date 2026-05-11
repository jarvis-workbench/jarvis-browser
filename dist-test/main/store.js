"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MetadataStore = exports.normalizeHttpUrl = void 0;
const electron_1 = require("electron");
const promises_1 = require("node:fs/promises");
const node_path_1 = require("node:path");
const data_paths_1 = require("./data-paths");
const extension_manifest_1 = require("./extension-manifest");
const internal_protocol_1 = require("./internal-protocol");
const manifest_1 = require("./jarvis-script/manifest");
const now = () => new Date().toISOString();
const createId = () => {
    if (globalThis.crypto?.randomUUID) {
        return globalThis.crypto.randomUUID();
    }
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
};
const cleanText = (value, label) => {
    const trimmed = value.trim();
    if (!trimmed) {
        throw new Error(`${label}不能为空`);
    }
    return trimmed;
};
const normalizeHttpUrl = (rawUrl) => {
    const trimmed = cleanText(rawUrl, "网址");
    const withProtocol = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
    const parsed = new URL(withProtocol);
    if (!["http:", "https:"].includes(parsed.protocol)) {
        throw new Error("仅支持 http 和 https 网址");
    }
    return parsed.toString();
};
exports.normalizeHttpUrl = normalizeHttpUrl;
class MetadataStore {
    sites = [];
    globalExtensions = [];
    globalJarvisScripts = [];
    downloads = [];
    profile = createDefaultProfile();
    downloadSettings = createDefaultDownloadSettings();
    loaded = false;
    writeQueue = Promise.resolve();
    async load() {
        if (this.loaded) {
            return;
        }
        await ensureBaseDirectories();
        this.profile = await readJson(data_paths_1.dataPaths.profileFile, createDefaultProfile());
        this.downloadSettings = normalizeDownloadSettings(this.profile.downloadSettings);
        this.globalExtensions = await hydrateExtensionsMetadata(await readJson(data_paths_1.dataPaths.global.extensionsIndexFile, []));
        this.globalJarvisScripts = await readJson(data_paths_1.dataPaths.global.jarvisScriptsIndexFile, []);
        this.downloads = (await readJson(data_paths_1.dataPaths.global.downloadsFile, []))
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
    getDownload(downloadId) {
        return this.downloads.find((download) => download.id === downloadId);
    }
    getDownloadSettings() {
        return structuredClone(this.downloadSettings);
    }
    async updateDownloadSettings(input) {
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
    listSiteJarvisScripts(siteId) {
        return structuredClone(this.requireSite(siteId).jarvisScripts);
    }
    getSite(siteId) {
        return this.sites.find((site) => site.id === siteId);
    }
    getSession(siteId, sessionId) {
        return this.getSite(siteId)?.sessions.find((session) => session.id === sessionId);
    }
    getGlobalExtension(extensionId) {
        return this.globalExtensions.find((extension) => extension.id === extensionId);
    }
    async addSite(input) {
        const timestamp = now();
        const url = (0, exports.normalizeHttpUrl)(input.url);
        this.assertUniqueSiteUrl(url);
        const title = input.title?.trim() ? cleanText(input.title, "站点名称") : "";
        const site = {
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
    async updateSite(siteId, input) {
        const site = this.requireSite(siteId);
        if (input.url !== undefined) {
            const url = (0, exports.normalizeHttpUrl)(input.url);
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
    async updateSiteMetadata(siteId, input) {
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
    async fillMissingSiteTitle(siteId, title) {
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
    async deleteSite(siteId) {
        const nextSites = this.sites.filter((site) => site.id !== siteId);
        if (nextSites.length === this.sites.length) {
            throw new Error("站点不存在");
        }
        this.sites = nextSites;
        await this.enqueue(async () => {
            await (0, promises_1.rm)(data_paths_1.dataPaths.sites.siteRoot(siteId), { recursive: true, force: true });
            await this.writeSitesIndex();
        });
    }
    async addSession(siteId, input) {
        const site = this.requireSite(siteId);
        const timestamp = now();
        const sessionName = input.name.trim() ? cleanText(input.name, "会话名称") : nextSessionName(site);
        this.assertUniqueSessionName(site, sessionName);
        const session = {
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
    async renameSession(siteId, sessionId, name) {
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
    async deleteSession(siteId, sessionId) {
        const site = this.requireSite(siteId);
        const nextSessions = site.sessions.filter((session) => session.id !== sessionId);
        if (nextSessions.length === site.sessions.length) {
            throw new Error("会话不存在");
        }
        site.sessions = nextSessions;
        site.updatedAt = now();
        await this.enqueue(async () => {
            await (0, promises_1.rm)(data_paths_1.dataPaths.sites.sessionRoot(siteId, sessionId), { recursive: true, force: true });
            await this.writeSite(site);
            await this.writeSessionsIndex(site);
            await this.writeSitesIndex();
        });
    }
    async upsertExtension(siteId, extension) {
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
    async upsertGlobalExtension(extension) {
        this.globalExtensions = [
            ...this.globalExtensions.filter((item) => item.id !== extension.id),
            extension,
        ];
        await this.persistGlobalExtensions();
        return structuredClone(extension);
    }
    async updateExtension(siteId, extensionId, input) {
        const site = this.requireSite(siteId);
        const extension = site.extensions.find((item) => item.id === extensionId);
        if (!extension) {
            throw new Error("扩展程序不存在");
        }
        Object.assign(extension, input, { updatedAt: now() });
        site.updatedAt = now();
        await this.persistSiteExtensions(site);
        await this.persistSiteAndIndex(site);
        return structuredClone(extension);
    }
    async updateGlobalExtension(extensionId, input) {
        const extension = this.globalExtensions.find((item) => item.id === extensionId);
        if (!extension) {
            throw new Error("扩展程序不存在");
        }
        Object.assign(extension, input, { updatedAt: now() });
        await this.persistGlobalExtensions();
        return structuredClone(extension);
    }
    async deleteExtension(siteId, extensionId) {
        const site = this.requireSite(siteId);
        const nextExtensions = site.extensions.filter((extension) => extension.id !== extensionId);
        if (nextExtensions.length === site.extensions.length) {
            throw new Error("扩展程序不存在");
        }
        site.extensions = nextExtensions;
        site.updatedAt = now();
        await this.enqueue(async () => {
            await (0, promises_1.rm)(data_paths_1.dataPaths.sites.extensionInstallDir(siteId, extensionId), { recursive: true, force: true });
            await this.writeSite(site);
            await this.writeSiteExtensionsIndex(site);
            await this.writeSitesIndex();
        });
    }
    async deleteGlobalExtension(extensionId) {
        const nextExtensions = this.globalExtensions.filter((extension) => extension.id !== extensionId);
        if (nextExtensions.length === this.globalExtensions.length) {
            throw new Error("扩展程序不存在");
        }
        this.globalExtensions = nextExtensions;
        await this.enqueue(async () => {
            await (0, promises_1.rm)(data_paths_1.dataPaths.global.extensionInstallDir(extensionId), { recursive: true, force: true });
            await this.writeGlobalExtensionsIndex();
        });
    }
    async installGlobalJarvisScriptSource(sourcePath) {
        const script = await (0, manifest_1.createJarvisScriptFromPath)(sourcePath, "global");
        const existing = this.globalJarvisScripts.find((item) => item.id === script.id);
        if (existing) {
            script.createdAt = existing.createdAt;
        }
        await this.installJarvisScriptSource(script, sourcePath, data_paths_1.dataPaths.global.jarvisScriptSourceDir(script.id), data_paths_1.dataPaths.global.jarvisScriptManifestFile(script.id));
        this.globalJarvisScripts = [
            ...this.globalJarvisScripts.filter((item) => item.id !== script.id),
            script,
        ];
        await this.persistGlobalJarvisScripts();
        return structuredClone(script);
    }
    async installSiteJarvisScriptSource(siteId, sourcePath) {
        const site = this.requireSite(siteId);
        const script = await (0, manifest_1.createJarvisScriptFromPath)(sourcePath, "site", siteId);
        const existing = site.jarvisScripts.find((item) => item.id === script.id);
        if (existing) {
            script.createdAt = existing.createdAt;
        }
        await this.installJarvisScriptSource(script, sourcePath, data_paths_1.dataPaths.sites.jarvisScriptSourceDir(siteId, script.id), data_paths_1.dataPaths.sites.jarvisScriptManifestFile(siteId, script.id));
        site.jarvisScripts = [
            ...site.jarvisScripts.filter((item) => item.id !== script.id),
            script,
        ];
        site.updatedAt = now();
        await this.persistSiteJarvisScripts(site);
        await this.persistSiteAndIndex(site);
        return structuredClone(script);
    }
    async updateGlobalJarvisScript(scriptId, input) {
        const script = this.globalJarvisScripts.find((item) => item.id === scriptId);
        if (!script) {
            throw new Error("Jarvis Script 不存在");
        }
        updateJarvisScript(script, input);
        await this.enqueue(async () => {
            await writeJson(data_paths_1.dataPaths.global.jarvisScriptManifestFile(script.id), script);
            await this.writeGlobalJarvisScriptsIndex();
        });
        return structuredClone(script);
    }
    async updateSiteJarvisScript(siteId, scriptId, input) {
        const site = this.requireSite(siteId);
        const script = site.jarvisScripts.find((item) => item.id === scriptId);
        if (!script) {
            throw new Error("Jarvis Script 不存在");
        }
        updateJarvisScript(script, input);
        site.updatedAt = now();
        await this.enqueue(async () => {
            await writeJson(data_paths_1.dataPaths.sites.jarvisScriptManifestFile(site.id, script.id), script);
            await this.writeSiteJarvisScriptsIndex(site);
            await this.writeSite(site);
            await this.writeSitesIndex();
        });
        return structuredClone(script);
    }
    async deleteGlobalJarvisScript(scriptId) {
        const nextScripts = this.globalJarvisScripts.filter((script) => script.id !== scriptId);
        if (nextScripts.length === this.globalJarvisScripts.length) {
            throw new Error("Jarvis Script 不存在");
        }
        this.globalJarvisScripts = nextScripts;
        await this.enqueue(async () => {
            await (0, promises_1.rm)(data_paths_1.dataPaths.global.jarvisScriptInstallDir(scriptId), { recursive: true, force: true });
            await this.writeGlobalJarvisScriptsIndex();
        });
    }
    async deleteSiteJarvisScript(siteId, scriptId) {
        const site = this.requireSite(siteId);
        const nextScripts = site.jarvisScripts.filter((script) => script.id !== scriptId);
        if (nextScripts.length === site.jarvisScripts.length) {
            throw new Error("Jarvis Script 不存在");
        }
        site.jarvisScripts = nextScripts;
        site.updatedAt = now();
        await this.enqueue(async () => {
            await (0, promises_1.rm)(data_paths_1.dataPaths.sites.jarvisScriptInstallDir(siteId, scriptId), { recursive: true, force: true });
            await this.writeSite(site);
            await this.writeSiteJarvisScriptsIndex(site);
            await this.writeSitesIndex();
        });
    }
    async upsertDownload(download) {
        const normalized = normalizeDownloadState(download);
        this.downloads = [
            normalized,
            ...this.downloads.filter((item) => item.id !== normalized.id),
        ].slice(0, 200);
        await this.persistDownloads();
        return structuredClone(normalized);
    }
    async removeDownload(downloadId) {
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
    async installGlobalExtensionSource(extension, sourcePath) {
        const sourceDir = data_paths_1.dataPaths.global.extensionSourceDir(extension.id);
        await replaceDirectory(sourcePath, sourceDir);
        extension.icon = remapInstalledPath(sourcePath, sourceDir, extension.icon);
        if (extension.action?.icon) {
            extension.action.icon = remapInstalledPath(sourcePath, sourceDir, extension.action.icon);
        }
        extension.path = sourceDir;
        await writeJson(data_paths_1.dataPaths.global.extensionManifestFile(extension.id), extension);
        return extension;
    }
    async installSiteExtensionSource(siteId, extension, sourcePath) {
        this.requireSite(siteId);
        const sourceDir = data_paths_1.dataPaths.sites.extensionSourceDir(siteId, extension.id);
        await replaceDirectory(sourcePath, sourceDir);
        extension.icon = remapInstalledPath(sourcePath, sourceDir, extension.icon);
        if (extension.action?.icon) {
            extension.action.icon = remapInstalledPath(sourcePath, sourceDir, extension.action.icon);
        }
        extension.path = sourceDir;
        await writeJson(data_paths_1.dataPaths.sites.extensionManifestFile(siteId, extension.id), extension);
        return extension;
    }
    async loadSites() {
        const index = await readJson(data_paths_1.dataPaths.sites.indexFile, []);
        const sites = [];
        for (const item of index) {
            const site = await readJson(data_paths_1.dataPaths.sites.siteFile(item.id), undefined);
            if (!site) {
                continue;
            }
            site.sessions = await this.loadSessions(site.id);
            site.extensions = await hydrateExtensionsMetadata(await readJson(data_paths_1.dataPaths.sites.extensionsIndexFile(site.id), []));
            site.jarvisScripts = await readJson(data_paths_1.dataPaths.sites.jarvisScriptsIndexFile(site.id), []);
            sites.push(site);
        }
        return sites;
    }
    async loadSessions(siteId) {
        const sessions = await readJson(data_paths_1.dataPaths.sites.sessionsIndexFile(siteId), []);
        return sessions.map((session) => ({
            ...session,
            siteId,
        }));
    }
    async persistSiteAndIndex(site) {
        await this.enqueue(async () => {
            await this.writeSite(site);
            await this.writeSitesIndex();
        });
    }
    async persistSiteExtensions(site) {
        await this.enqueue(async () => {
            await this.writeSiteExtensionsIndex(site);
        });
    }
    async persistGlobalExtensions() {
        await this.enqueue(async () => {
            await this.writeGlobalExtensionsIndex();
        });
    }
    async persistSiteJarvisScripts(site) {
        await this.enqueue(async () => {
            await this.writeSiteJarvisScriptsIndex(site);
        });
    }
    async persistGlobalJarvisScripts() {
        await this.enqueue(async () => {
            await this.writeGlobalJarvisScriptsIndex();
        });
    }
    async persistDownloads() {
        await this.enqueue(async () => {
            await writeJson(data_paths_1.dataPaths.global.downloadsFile, this.downloads);
        });
    }
    async persistProfile() {
        await this.enqueue(async () => {
            await writeJson(data_paths_1.dataPaths.profileFile, this.profile);
        });
    }
    async persistLoadedState() {
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
                    await writeJson(data_paths_1.dataPaths.sites.sessionFile(site.id, siteSession.id), siteSession);
                }
            }
        });
    }
    async writeSite(site) {
        await (0, promises_1.mkdir)(data_paths_1.dataPaths.sites.siteRoot(site.id), { recursive: true });
        await (0, promises_1.mkdir)(data_paths_1.dataPaths.sites.faviconRoot(site.id), { recursive: true });
        await (0, promises_1.mkdir)(data_paths_1.dataPaths.sites.extensionsRoot(site.id), { recursive: true });
        await (0, promises_1.mkdir)(data_paths_1.dataPaths.sites.jarvisScriptsRoot(site.id), { recursive: true });
        await (0, promises_1.mkdir)(data_paths_1.dataPaths.sites.sessionsRoot(site.id), { recursive: true });
        await writeJson(data_paths_1.dataPaths.sites.siteFile(site.id), site);
    }
    async writeSession(site, session) {
        await (0, promises_1.mkdir)(data_paths_1.dataPaths.sites.sessionRoot(site.id, session.id), { recursive: true });
        await (0, promises_1.mkdir)(data_paths_1.dataPaths.sites.sessionDownloadsDir(site.id, session.id), { recursive: true });
        await writeJson(data_paths_1.dataPaths.sites.sessionFile(site.id, session.id), session);
        await this.writeSessionsIndex(site);
    }
    async writeSitesIndex() {
        await writeJson(data_paths_1.dataPaths.sites.indexFile, this.sites.map(toSiteIndexItem));
    }
    async writeSessionsIndex(site) {
        await (0, promises_1.mkdir)(data_paths_1.dataPaths.sites.sessionsRoot(site.id), { recursive: true });
        await writeJson(data_paths_1.dataPaths.sites.sessionsIndexFile(site.id), site.sessions);
    }
    async writeSiteExtensionsIndex(site) {
        await (0, promises_1.mkdir)(data_paths_1.dataPaths.sites.extensionsRoot(site.id), { recursive: true });
        await writeJson(data_paths_1.dataPaths.sites.extensionsIndexFile(site.id), site.extensions);
    }
    async writeSiteJarvisScriptsIndex(site) {
        await (0, promises_1.mkdir)(data_paths_1.dataPaths.sites.jarvisScriptsRoot(site.id), { recursive: true });
        await writeJson(data_paths_1.dataPaths.sites.jarvisScriptsIndexFile(site.id), site.jarvisScripts);
    }
    async writeGlobalExtensionsIndex() {
        await (0, promises_1.mkdir)(data_paths_1.dataPaths.global.extensionsRoot, { recursive: true });
        await writeJson(data_paths_1.dataPaths.global.extensionsIndexFile, this.globalExtensions);
    }
    async writeGlobalJarvisScriptsIndex() {
        await (0, promises_1.mkdir)(data_paths_1.dataPaths.global.jarvisScriptsRoot, { recursive: true });
        await writeJson(data_paths_1.dataPaths.global.jarvisScriptsIndexFile, this.globalJarvisScripts);
    }
    async installJarvisScriptSource(script, sourcePath, sourceDir, manifestFile) {
        await replaceDirectory(sourcePath, sourceDir);
        script.path = sourceDir;
        script.updatedAt = now();
        await writeJson(manifestFile, script);
    }
    requireSite(siteId) {
        const site = this.getSite(siteId);
        if (!site) {
            throw new Error("站点不存在");
        }
        return site;
    }
    requireSession(siteId, sessionId) {
        const site = this.requireSite(siteId);
        const session = site.sessions.find((item) => item.id === sessionId);
        if (!session) {
            throw new Error("会话不存在");
        }
        return { site, session };
    }
    assertUniqueSessionName(site, sessionName, exceptSessionId) {
        const exists = site.sessions.some((session) => session.id !== exceptSessionId && session.name === sessionName);
        if (exists) {
            throw new Error("同一站点下已存在同名会话");
        }
    }
    assertUniqueSiteUrl(url, exceptSiteId) {
        const exists = this.sites.some((site) => site.id !== exceptSiteId && site.url === url);
        if (exists) {
            throw new Error("该站点地址已存在");
        }
    }
    async enqueue(work) {
        this.writeQueue = this.writeQueue.then(work);
        await this.writeQueue;
    }
}
exports.MetadataStore = MetadataStore;
async function ensureBaseDirectories() {
    await (0, promises_1.mkdir)(data_paths_1.dataPaths.userRoot, { recursive: true });
    await (0, promises_1.mkdir)(data_paths_1.dataPaths.global.root, { recursive: true });
    await (0, promises_1.mkdir)(data_paths_1.dataPaths.global.extensionsRoot, { recursive: true });
    await (0, promises_1.mkdir)(data_paths_1.dataPaths.global.jarvisScriptsRoot, { recursive: true });
    await (0, promises_1.mkdir)(data_paths_1.dataPaths.sites.root, { recursive: true });
    await (0, promises_1.mkdir)(data_paths_1.dataPaths.runtime.userData, { recursive: true });
    await (0, promises_1.mkdir)(data_paths_1.dataPaths.runtime.sessionData, { recursive: true });
    await writeJsonIfMissing(data_paths_1.dataPaths.profileFile, createDefaultProfile());
    await writeJsonIfMissing(data_paths_1.dataPaths.global.metadataFile, {
        userId: "default",
        updatedAt: now(),
    });
    await writeJsonIfMissing(data_paths_1.dataPaths.global.downloadsFile, []);
    await writeJsonIfMissing(data_paths_1.dataPaths.global.extensionsIndexFile, []);
    await writeJsonIfMissing(data_paths_1.dataPaths.global.jarvisScriptsIndexFile, []);
    await writeJsonIfMissing(data_paths_1.dataPaths.sites.indexFile, []);
}
function createDefaultProfile() {
    return {
        id: "default",
        name: "default",
        createdAt: now(),
        downloadSettings: createDefaultDownloadSettings(),
    };
}
function createDefaultDownloadSettings() {
    return {
        downloadPath: electron_1.app.getPath("downloads"),
        askWhereToSaveBeforeDownloading: false,
    };
}
function normalizeDownloadSettings(input) {
    const fallback = createDefaultDownloadSettings();
    return {
        downloadPath: typeof input?.downloadPath === "string" && input.downloadPath.trim()
            ? input.downloadPath
            : fallback.downloadPath,
        askWhereToSaveBeforeDownloading: Boolean(input?.askWhereToSaveBeforeDownloading),
    };
}
function normalizeDownloadState(input) {
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
async function hydrateExtensionsMetadata(extensions) {
    return Promise.all(extensions.map(async (extension) => {
        if (extension.action?.defaultPopup) {
            return extension;
        }
        try {
            const metadata = await (0, extension_manifest_1.readExtensionManifestMetadata)(extension.path);
            return {
                ...extension,
                name: extension.name || metadata.name,
                version: extension.version || metadata.version,
                permissions: extension.permissions?.length ? extension.permissions : metadata.permissions,
                action: extension.action ?? metadata.action,
                icon: extension.icon ?? metadata.icon,
            };
        }
        catch {
            return extension;
        }
    }));
}
function toSiteIndexItem(site) {
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
function toRendererSite(site) {
    const nextSite = structuredClone(site);
    if (nextSite.faviconPath) {
        nextSite.faviconPath = (0, internal_protocol_1.createSiteFaviconInternalUrl)(site.id);
    }
    return nextSite;
}
function nextSessionName(site) {
    let index = site.sessions.length + 1;
    while (site.sessions.some((session) => session.name === `会话 ${index}`)) {
        index += 1;
    }
    return `会话 ${index}`;
}
function updateJarvisScript(script, input) {
    if (input.runtimeState) {
        script.runtimeState = {
            ...script.runtimeState,
            ...input.runtimeState,
        };
    }
    script.updatedAt = now();
}
async function readJson(filePath, fallback) {
    try {
        return JSON.parse(await (0, promises_1.readFile)(filePath, "utf8"));
    }
    catch (error) {
        if (error.code === "ENOENT") {
            return fallback;
        }
        throw error;
    }
}
async function writeJson(filePath, value) {
    await (0, promises_1.mkdir)((0, node_path_1.dirname)(filePath), { recursive: true });
    await (0, promises_1.writeFile)(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
async function writeJsonIfMissing(filePath, value) {
    try {
        await (0, promises_1.readFile)(filePath, "utf8");
    }
    catch (error) {
        if (error.code !== "ENOENT") {
            throw error;
        }
        await writeJson(filePath, value);
    }
}
async function replaceDirectory(sourcePath, targetPath) {
    await (0, promises_1.rm)(targetPath, { recursive: true, force: true });
    await (0, promises_1.mkdir)((0, node_path_1.dirname)(targetPath), { recursive: true });
    await (0, promises_1.cp)(sourcePath, targetPath, { recursive: true, force: true });
}
function remapInstalledPath(sourceRoot, targetRoot, sourceFile) {
    if (!sourceFile || !(0, node_path_1.isAbsolute)(sourceFile)) {
        return sourceFile;
    }
    const childPath = (0, node_path_1.relative)(sourceRoot, sourceFile);
    if (childPath.startsWith("..")) {
        return sourceFile;
    }
    return (0, node_path_1.join)(targetRoot, childPath);
}
