import { dialog } from "electron";
import { ZipReader, ZipWriter, TextReader, TextWriter, Uint8ArrayReader, Uint8ArrayWriter, type Entry } from "@zip.js/zip.js";
import { cp, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, relative } from "node:path";
import type {
  SessionSyncApplyImportInput,
  SessionSyncApplyImportResult,
  SessionSyncConflictAction,
  SessionSyncExportInput,
  SessionSyncExportResult,
  SessionSyncPreviewImportInput,
  SessionSyncPreviewImportResult,
  SessionSyncPreviewSite,
  SessionSyncPreviewSession,
  Site,
  SiteSession,
} from "../shared/types";
import { dataPaths } from "./data-paths";
import { flushElectronSession, getElectronSession, getSessionPartitionDataPath } from "./electron-session-manager";
import { MetadataStore } from "./store";

const manifestVersion = "jarvis-session-sync-v1";
const chromeSyncPackageType = "jarvis-session-sync";
const fileExtension = ".jarvis-session-sync.zip";
const webStatePrefix = "web-state/";

type SessionSyncManifest = {
  version: typeof manifestVersion;
  exportedAt: string;
  encrypted: boolean;
  sites: Array<{
    id: string;
    sitePath: string;
    faviconPath?: string;
    sessions: Array<{
      id: string;
      sessionPath: string;
      partitionPath?: string;
      webStatePath?: string;
    }>;
  }>;
};

type ChromeSyncPackageManifest = {
  packageType: typeof chromeSyncPackageType;
  formatVersion: typeof manifestVersion;
  createdAt?: string;
  files?: {
    webState?: string;
  };
  source?: {
    url?: string;
    topOrigin?: string;
  };
};

type ChromeSyncWebState = {
  version: typeof manifestVersion;
  metadata?: {
    exportedAt?: string;
    url?: string;
    topOrigin?: string;
  };
};

type PendingSession = {
  metadata: SiteSession;
  hasPartition: boolean;
  hasWebState: boolean;
};

type PendingSite = {
  manifestSite: SessionSyncManifest["sites"][number];
  metadata: Site;
  faviconPath?: string;
  sessions: PendingSession[];
};

type PendingImport = {
  importId: string;
  filePath: string;
  tempDir: string;
  manifest: SessionSyncManifest | ChromeSyncPackageManifest;
  sites: PendingSite[];
  preview: SessionSyncPreviewImportResult;
};

type BrowserHostLike = {
  closeSession(siteId: string, sessionId: string): Promise<void>;
};

export class SessionSyncManager {
  private readonly pendingImports = new Map<string, PendingImport>();

  constructor(
    private readonly store: MetadataStore,
    private readonly browserHost: BrowserHostLike,
  ) {}

  async export(input: SessionSyncExportInput): Promise<SessionSyncExportResult> {
    const encrypted = input.encrypted !== false;
    const password = input.password?.trim();
    if (encrypted && !password) {
      throw new Error("加密导出需要输入密码");
    }

    const selections = this.resolveExportSelections(input);
    if (!selections.length) {
      throw new Error("请选择要导出的会话");
    }

    const exportSites = this.collectExportSites(selections);
    const defaultPath = join(dataPaths.userRoot, createDefaultExportFileName(exportSites[0]?.site));
    const saveResult = await dialog.showSaveDialog({
      title: "导出 Jarvis Session",
      defaultPath,
      filters: [{ name: "Jarvis Session Sync", extensions: ["jarvis-session-sync.zip"] }],
      properties: ["createDirectory", "showOverwriteConfirmation"],
    });

    if (saveResult.canceled || !saveResult.filePath) {
      return {
        canceled: true,
        exportedSites: 0,
        exportedSessions: 0,
        exportedSiteCount: 0,
        exportedSessionCount: 0,
      };
    }

    const filePath = ensureSessionSyncExtension(saveResult.filePath);
    await mkdir(dirname(filePath), { recursive: true });
    const writer = new ZipWriter(new Uint8ArrayWriter(), encrypted ? { password } : undefined);
    try {
      const manifest: SessionSyncManifest = {
        version: manifestVersion,
        exportedAt: new Date().toISOString(),
        encrypted,
        sites: [],
      };

      for (const exportSite of exportSites) {
        const sitePath = `sites/${exportSite.site.id}/site.json`;
        const manifestSite: SessionSyncManifest["sites"][number] = {
          id: exportSite.site.id,
          sitePath,
          sessions: [],
        };
        manifest.sites.push(manifestSite);
        await writer.add(sitePath, new TextReader(JSON.stringify(exportSite.site, null, 2)));

        const faviconPath = await this.addFavicon(writer, exportSite.site);
        if (faviconPath) {
          manifestSite.faviconPath = faviconPath;
        }

        for (const siteSession of exportSite.sessions) {
          const targetSession = getElectronSession(exportSite.site.id, siteSession.id);
          await flushElectronSession(targetSession);

          const sessionPath = `sites/${exportSite.site.id}/sessions/${siteSession.id}/session.json`;
          const partitionPath = `sites/${exportSite.site.id}/sessions/${siteSession.id}/partition`;
          const manifestSession: SessionSyncManifest["sites"][number]["sessions"][number] = {
            id: siteSession.id,
            sessionPath,
          };
          manifestSite.sessions.push(manifestSession);
          await writer.add(sessionPath, new TextReader(JSON.stringify(siteSession, null, 2)));

          const sourcePartitionPath = getSessionPartitionDataPath(exportSite.site.id, siteSession.id);
          if (await pathExists(sourcePartitionPath)) {
            await addDirectoryToZip(writer, sourcePartitionPath, partitionPath);
            manifestSession.partitionPath = partitionPath;
          }
        }
      }

      await writer.add("manifest.json", new TextReader(JSON.stringify(manifest, null, 2)));
      const bytes = Buffer.from(await writer.close());
      await writeFile(filePath, bytes);
    } catch (error) {
      await writer.close().catch(() => undefined);
      throw error;
    }

    const exportedSessions = exportSites.reduce((count, site) => count + site.sessions.length, 0);
    return {
      canceled: false,
      filePath,
      exportedSites: exportSites.length,
      exportedSessions,
      exportedSiteCount: exportSites.length,
      exportedSessionCount: exportedSessions,
    };
  }

  async previewImport(input: SessionSyncPreviewImportInput): Promise<SessionSyncPreviewImportResult> {
    const result = await dialog.showOpenDialog({
      title: "导入 Jarvis Session",
      filters: [{ name: "Jarvis Session Sync", extensions: ["jarvis-session-sync.zip", "zip"] }],
      properties: ["openFile"],
    });

    if (result.canceled || !result.filePaths[0]) {
      return createCanceledPreview();
    }

    const filePath = result.filePaths[0];
    const tempDir = await mkdtemp(join(tmpdir(), "jarvis-session-sync-"));
    let reader: ZipReader<Buffer> | undefined;
    try {
      reader = new ZipReader(new Uint8ArrayReader(await readFile(filePath)), input.password ? { password: input.password } : undefined);
      const entryList = await reader.getEntries();
      const entries = new Map(entryList.map((entry) => [entry.filename, entry]));
      const manifest = await readJsonEntry<SessionSyncManifest | ChromeSyncPackageManifest>(entries, "manifest.json", input.password);
      if (!isSessionSyncManifest(manifest) && !isChromeSyncPackageManifest(manifest)) {
        throw new Error("不支持的 session sync 文件版本");
      }

      const sites = isSessionSyncManifest(manifest)
        ? await this.readPendingSites(manifest, entries, tempDir, input.password)
        : await this.readChromeSyncPendingSites(manifest, entries, input.password);
      const importId = createId();
      const preview = this.createPreview(importId, filePath, isSessionSyncManifest(manifest) && manifest.encrypted, sites, input);
      this.pendingImports.set(importId, {
        importId,
        filePath,
        tempDir,
        manifest,
        sites,
        preview,
      });
      return preview;
    } catch (error) {
      await rm(tempDir, { recursive: true, force: true });
      throw error;
    } finally {
      await reader?.close();
    }
  }

  async applyImport(input: SessionSyncApplyImportInput): Promise<SessionSyncApplyImportResult> {
    const pending = this.pendingImports.get(input.importId);
    if (!pending) {
      throw new Error("导入任务不存在或已过期");
    }

    const siteDefaultAction = normalizeConflictAction(input.siteConflictAction);
    const sessionDefaultAction = normalizeConflictAction(input.sessionConflictAction);
    const report: SessionSyncApplyImportResult = {
      importedSites: 0,
      updatedSites: 0,
      importedSessions: 0,
      overwrittenSessions: 0,
      skippedSessions: [],
      unsupportedSessions: [],
      importedSiteCount: 0,
      importedSessionCount: 0,
      skippedSiteCount: 0,
      skippedSessionCount: 0,
    };

    try {
      for (const previewSite of pending.preview.sites) {
        const pendingSite = pending.sites.find((site) => site.metadata.id === previewSite.sourceSiteId);
        if (!pendingSite || !previewSite.importable) {
          for (const previewSession of previewSite.sessions) {
            report.skippedSessions.push({
              sourceSiteId: previewSession.sourceSiteId,
              sourceSessionId: previewSession.sourceSessionId,
              reason: previewSite.skippedReason ?? "站点不可导入",
            });
          }
          continue;
        }

        const siteAction = normalizeConflictAction(input.siteConflicts?.[previewSite.sourceSiteId], siteDefaultAction);
        let targetSite: Site | undefined;

        for (const previewSession of previewSite.sessions) {
          const pendingSession = pendingSite.sessions.find((session) => session.metadata.id === previewSession.sourceSessionId);
          if (!pendingSession || !previewSession.importable) {
            report.skippedSessions.push({
              sourceSiteId: previewSession.sourceSiteId,
              sourceSessionId: previewSession.sourceSessionId,
              reason: previewSession.skippedReason ?? "会话不可导入",
            });
            continue;
          }

          if (!pendingSession.hasPartition) {
            const reason = pendingSession.hasWebState ? "web state 导入暂未由主进程支持" : "缺少 partition 快照";
            report.unsupportedSessions.push({
              sourceSiteId: previewSession.sourceSiteId,
              sourceSessionId: previewSession.sourceSessionId,
              reason,
            });
            continue;
          }

          if (!targetSite) {
            targetSite = await this.ensureTargetSite(pendingSite, previewSite, siteAction, report);
            if (!targetSite) {
              report.skippedSessions.push({
                sourceSiteId: previewSession.sourceSiteId,
                sourceSessionId: previewSession.sourceSessionId,
                reason: "站点冲突已跳过",
              });
              continue;
            }
          }

          const sessionAction = normalizeConflictAction(
            input.sessionConflicts?.[`${previewSession.sourceSiteId}:${previewSession.sourceSessionId}`]
              ?? input.sessionConflicts?.[previewSession.sourceSessionId],
            sessionDefaultAction,
          );
          await this.applySession(pending, pendingSession, targetSite.id, previewSession, sessionAction, report);
        }
      }
    } catch (error) {
      throw error;
    } finally {
      await this.cancelImport(input.importId);
    }

    report.importedSiteCount = report.importedSites;
    report.importedSessionCount = report.importedSessions + report.overwrittenSessions;
    report.skippedSessionCount = report.skippedSessions.length + report.unsupportedSessions.length;
    return report;
  }

  async cancelImport(importId: string) {
    const pending = this.pendingImports.get(importId);
    if (!pending) {
      return;
    }

    this.pendingImports.delete(importId);
    await rm(pending.tempDir, { recursive: true, force: true });
  }

  private resolveExportSelections(input: SessionSyncExportInput) {
    if (input.sessions?.length) {
      return input.sessions;
    }

    const siteIds = new Set(input.siteIds ?? (input.siteId ? [input.siteId] : []));
    const sessionIds = new Set(input.sessionIds ?? []);
    const selections: Array<{ siteId: string; sessionId: string }> = [];
    for (const site of this.store.listSites()) {
      if (siteIds.size && !siteIds.has(site.id)) {
        continue;
      }

      for (const siteSession of site.sessions) {
        if (sessionIds.size && !sessionIds.has(siteSession.id)) {
          continue;
        }

        selections.push({ siteId: site.id, sessionId: siteSession.id });
      }
    }

    return selections;
  }

  private collectExportSites(selections: Array<{ siteId: string; sessionId: string }>) {
    const siteMap = new Map<string, { site: Site; sessions: SiteSession[] }>();
    for (const selection of selections) {
      const site = this.store.getSite(selection.siteId);
      const siteSession = this.store.getSession(selection.siteId, selection.sessionId);
      if (!site || !siteSession) {
        throw new Error("导出会话不存在");
      }

      const exportSite = siteMap.get(site.id) ?? { site: structuredClone(site), sessions: [] };
      exportSite.sessions.push(structuredClone(siteSession));
      siteMap.set(site.id, exportSite);
    }

    for (const exportSite of siteMap.values()) {
      exportSite.site.sessions = exportSite.sessions;
    }

    return [...siteMap.values()];
  }

  private async addFavicon(writer: ZipWriter<Uint8Array>, site: Site) {
    const faviconPath = site.faviconPath?.replace(/^file:\/\//, "");
    if (!faviconPath || !(await pathExists(faviconPath))) {
      return undefined;
    }

    const entryPath = `sites/${site.id}/favicon/${basename(faviconPath)}`;
    await writer.add(entryPath, new Uint8ArrayReader(await readFile(faviconPath)));
    return entryPath;
  }

  private async readPendingSites(
    manifest: SessionSyncManifest,
    entries: Map<string, Entry>,
    tempDir: string,
    password?: string,
  ) {
    const sites: PendingSite[] = [];
    for (const manifestSite of manifest.sites) {
      const siteMetadata = await readJsonEntry<Site>(entries, manifestSite.sitePath, password);
      const pendingSite: PendingSite = {
        manifestSite,
        metadata: siteMetadata,
        faviconPath: undefined,
        sessions: [],
      };

      if (manifestSite.faviconPath) {
        const faviconEntry = entries.get(manifestSite.faviconPath);
        if (faviconEntry && !faviconEntry.directory) {
          const faviconPath = join(tempDir, "sites", manifestSite.id, "favicon", basename(manifestSite.faviconPath));
          await mkdir(dirname(faviconPath), { recursive: true });
          await writeFile(
            faviconPath,
            Buffer.from(await faviconEntry.getData(new Uint8ArrayWriter(), password ? { password } : undefined)),
          );
          pendingSite.faviconPath = faviconPath;
        }
      }

      for (const manifestSession of manifestSite.sessions) {
        const sessionMetadata = await readJsonEntry<SiteSession>(entries, manifestSession.sessionPath, password);
        const partitionEntries = manifestSession.partitionPath
          ? entriesWithPrefix(entries, normalizeDirPrefix(manifestSession.partitionPath))
          : [];
        const webStateEntries = manifestSession.webStatePath
          ? entriesWithPrefix(entries, normalizeDirPrefix(manifestSession.webStatePath))
          : entriesWithPrefix(entries, `sites/${manifestSite.id}/sessions/${manifestSession.id}/${webStatePrefix}`);

        if (partitionEntries.length && manifestSession.partitionPath) {
          const targetRoot = join(tempDir, "sites", manifestSite.id, "sessions", manifestSession.id, "partition");
          await extractEntries(partitionEntries, normalizeDirPrefix(manifestSession.partitionPath), targetRoot, password);
        }

        if (webStateEntries.length) {
          const webStateRoot = join(tempDir, "sites", manifestSite.id, "sessions", manifestSession.id, "web-state");
          const prefix = manifestSession.webStatePath
            ? normalizeDirPrefix(manifestSession.webStatePath)
            : `sites/${manifestSite.id}/sessions/${manifestSession.id}/${webStatePrefix}`;
          await extractEntries(webStateEntries, prefix, webStateRoot, password);
        }

        pendingSite.sessions.push({
          metadata: sessionMetadata,
          hasPartition: partitionEntries.length > 0,
          hasWebState: webStateEntries.length > 0,
        });
      }

      sites.push(pendingSite);
    }

    return sites;
  }

  private async readChromeSyncPendingSites(
    manifest: ChromeSyncPackageManifest,
    entries: Map<string, Entry>,
    password?: string,
  ) {
    const webStatePath = manifest.files?.webState || "web-state.json";
    const webState = await readJsonEntry<ChromeSyncWebState>(entries, webStatePath, password);
    if (webState.version !== manifestVersion) {
      throw new Error("不支持的 session sync 文件版本");
    }

    const url = normalizeWebStateUrl(
      webState.metadata?.url
        || manifest.source?.url
        || webState.metadata?.topOrigin
        || manifest.source?.topOrigin,
    );
    const timestamp = webState.metadata?.exportedAt || manifest.createdAt || new Date().toISOString();
    const siteId = createId();
    const sessionId = createId();
    const host = hostFromUrl(url);
    return [{
      manifestSite: {
        id: siteId,
        sitePath: "manifest.json",
        sessions: [{
          id: sessionId,
          sessionPath: webStatePath,
          webStatePath,
        }],
      },
      metadata: {
        id: siteId,
        title: host,
        name: host,
        url,
        sessions: [],
        extensions: [],
        jarvisScripts: [],
        createdAt: timestamp,
        updatedAt: timestamp,
      },
      sessions: [{
        metadata: {
          id: sessionId,
          siteId,
          name: "导入的登录状态",
          lastUrl: url,
          url,
          createdAt: timestamp,
          updatedAt: timestamp,
        },
        hasPartition: false,
        hasWebState: true,
      }],
    } satisfies PendingSite];
  }

  private createPreview(
    importId: string,
    filePath: string,
    encrypted: boolean,
    pendingSites: PendingSite[],
    input: SessionSyncPreviewImportInput,
  ): SessionSyncPreviewImportResult {
    const existingSites = this.store.listSites();
    const scopedSite = input.scope === "site" && input.siteId ? this.store.getSite(input.siteId) : undefined;
    const previewSites: SessionSyncPreviewSite[] = pendingSites.map((pendingSite) => {
      const sourceHost = hostFromUrl(pendingSite.metadata.url);
      const existingSite = input.scope === "site"
        ? scopedSite
        : existingSites.find((site) => hostFromUrl(site.url) === sourceHost);
      const scopeMismatch = input.scope === "site" && (!scopedSite || hostFromUrl(scopedSite.url) !== sourceHost);
      const targetSiteId = existingSite?.id;
      const sessions = pendingSite.sessions.map((pendingSession) => {
        const existingSession = existingSite?.sessions.find((siteSession) => siteSession.name === pendingSession.metadata.name);
        const importable = !scopeMismatch;
        return {
          id: pendingSession.metadata.id,
          sourceSiteId: pendingSite.metadata.id,
          sourceSessionId: pendingSession.metadata.id,
          name: pendingSession.metadata.name,
          siteId: targetSiteId,
          lastUrl: pendingSession.metadata.lastUrl,
          duplicate: Boolean(existingSession),
          existingSessionId: existingSession?.id,
          targetSiteId,
          targetSessionId: existingSession?.id,
          conflict: existingSession ? "session-name" : "none",
          hasPartition: pendingSession.hasPartition,
          hasWebState: pendingSession.hasWebState,
          importable,
          skippedReason: scopeMismatch ? "站点 host 与当前站点不一致" : undefined,
        } satisfies SessionSyncPreviewSession;
      });

      return {
        id: pendingSite.metadata.id,
        sourceSiteId: pendingSite.metadata.id,
        title: pendingSite.metadata.title,
        url: pendingSite.metadata.url,
        host: sourceHost,
        duplicate: Boolean(existingSite),
        existingSiteId: existingSite?.id,
        targetSiteId,
        conflict: existingSite ? "site-host" : "none",
        importable: !scopeMismatch,
        skippedReason: scopeMismatch ? "站点 host 与当前站点不一致" : undefined,
        sessions,
      };
    });

    const totalSessions = previewSites.reduce((count, site) => count + site.sessions.length, 0);
    const importableSessions = previewSites.reduce(
      (count, site) => count + site.sessions.filter((siteSession) => siteSession.importable).length,
      0,
    );
    return {
      canceled: false,
      importId,
      filePath,
      fileName: basename(filePath),
      encrypted,
      sites: previewSites,
      duplicateSiteCount: previewSites.filter((site) => site.duplicate).length,
      duplicateSessionCount: previewSites.reduce(
        (count, site) => count + site.sessions.filter((siteSession) => siteSession.duplicate).length,
        0,
      ),
      summary: {
        totalSites: previewSites.length,
        importableSites: previewSites.filter((site) => site.importable).length,
        totalSessions,
        importableSessions,
      },
    };
  }

  private async ensureTargetSite(
    pendingSite: PendingSite,
    previewSite: SessionSyncPreviewSite,
    siteAction: SessionSyncConflictAction,
    report: SessionSyncApplyImportResult,
  ) {
    if (!previewSite.targetSiteId) {
      const site = await this.store.importSiteMetadata({
        ...pendingSite.metadata,
        sessions: [],
        faviconPath: undefined,
      });
      await this.restoreFavicon(pendingSite, site.id, true);
      report.importedSites += 1;
      return site;
    }

    const existingSite = this.store.getSite(previewSite.targetSiteId);
    if (!existingSite) {
      return undefined;
    }

    if (siteAction === "overwrite" || siteAction === "overwrite-all") {
      const faviconPath = await this.restoreFavicon(pendingSite, existingSite.id, false);
      await this.store.updateImportedSiteMetadata(existingSite.id, {
        title: pendingSite.metadata.title,
        name: pendingSite.metadata.name,
        faviconUrl: pendingSite.metadata.faviconUrl,
        faviconPath: faviconPath ?? existingSite.faviconPath,
      });
      report.updatedSites += 1;
    }

    return this.store.getSite(existingSite.id);
  }

  private async restoreFavicon(pendingSite: PendingSite, targetSiteId: string, updateMetadata: boolean) {
    if (!pendingSite.faviconPath || !(await pathExists(pendingSite.faviconPath))) {
      return undefined;
    }

    const extension = extname(pendingSite.faviconPath) || ".ico";
    const targetPath = dataPaths.sites.faviconFile(targetSiteId, extension);
    await mkdir(dirname(targetPath), { recursive: true });
    await cp(pendingSite.faviconPath, targetPath, { force: true });
    if (updateMetadata) {
      await this.store.updateImportedSiteMetadata(targetSiteId, {
        faviconUrl: pendingSite.metadata.faviconUrl,
        faviconPath: targetPath,
      });
    }
    return targetPath;
  }

  private async applySession(
    pending: PendingImport,
    pendingSession: PendingSession,
    targetSiteId: string,
    previewSession: SessionSyncPreviewSession,
    sessionAction: SessionSyncConflictAction,
    report: SessionSyncApplyImportResult,
  ) {
    if (previewSession.targetSessionId && sessionAction === "skip") {
      report.skippedSessions.push({
        sourceSiteId: previewSession.sourceSiteId,
        sourceSessionId: previewSession.sourceSessionId,
        reason: "会话冲突已跳过",
      });
      return;
    }

    const targetSessionId = previewSession.targetSessionId && (sessionAction === "overwrite" || sessionAction === "overwrite-all")
      ? previewSession.targetSessionId
      : createId();
    const sourcePartitionPath = join(
      getPendingSessionTempDir(pending.tempDir, previewSession.sourceSiteId, previewSession.sourceSessionId),
      "partition",
    );
    const targetPartitionPath = getSessionPartitionDataPath(targetSiteId, targetSessionId);
    await this.replacePartition(targetSiteId, targetSessionId, sourcePartitionPath, targetPartitionPath, async () => {
      await this.store.importSessionMetadata(targetSiteId, {
        ...pendingSession.metadata,
        id: targetSessionId,
        siteId: targetSiteId,
      }, { targetSessionId: previewSession.targetSessionId });
    });

    if (previewSession.targetSessionId) {
      report.overwrittenSessions += 1;
    } else {
      report.importedSessions += 1;
    }
  }

  private async replacePartition(
    siteId: string,
    sessionId: string,
    sourcePath: string,
    targetPath: string,
    afterReplace: () => Promise<void>,
  ) {
    const backupPath = `${targetPath}.backup-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    let backedUp = false;
    await this.browserHost.closeSession(siteId, sessionId);
    try {
      if (await pathExists(targetPath)) {
        await mkdir(dirname(backupPath), { recursive: true });
        await rename(targetPath, backupPath);
        backedUp = true;
      }

      await mkdir(dirname(targetPath), { recursive: true });
      await cp(sourcePath, targetPath, { recursive: true, force: true });
      await afterReplace();
      if (backedUp) {
        await rm(backupPath, { recursive: true, force: true });
      }
    } catch (error) {
      await rm(targetPath, { recursive: true, force: true });
      if (backedUp) {
        await rename(backupPath, targetPath);
      }
      throw error;
    }
  }
}

async function readJsonEntry<T>(entries: Map<string, Entry>, entryPath: string, password?: string) {
  const entry = entries.get(entryPath);
  if (!entry || entry.directory) {
    throw new Error(`导入文件缺少 ${entryPath}`);
  }

  return JSON.parse(await entry.getData(new TextWriter(), password ? { password } : undefined)) as T;
}

async function extractEntries(entries: Entry[], sourcePrefix: string, targetRoot: string, password?: string) {
  for (const entry of entries) {
    if (entry.directory) {
      continue;
    }

    const childPath = relativeZipPath(sourcePrefix, entry.filename);
    if (!childPath) {
      continue;
    }

    const targetPath = join(targetRoot, childPath);
    if (!isPathInside(targetRoot, targetPath)) {
      throw new Error("导入文件包含非法路径");
    }

    await mkdir(dirname(targetPath), { recursive: true });
    await writeFile(targetPath, Buffer.from(await entry.getData(new Uint8ArrayWriter(), password ? { password } : undefined)));
  }
}

async function addDirectoryToZip(writer: ZipWriter<Uint8Array>, sourceRoot: string, zipRoot: string) {
  const entries = await listFiles(sourceRoot);
  for (const filePath of entries) {
    const zipPath = `${zipRoot}/${toZipPath(relative(sourceRoot, filePath))}`;
    await writer.add(zipPath, new Uint8ArrayReader(await readFile(filePath)));
  }
}

async function listFiles(root: string) {
  const output: string[] = [];
  const items = await readdir(root, { withFileTypes: true });
  for (const item of items) {
    const itemPath = join(root, item.name);
    if (item.isDirectory()) {
      output.push(...await listFiles(itemPath));
    } else if (item.isFile()) {
      output.push(itemPath);
    }
  }
  return output;
}

function entriesWithPrefix(entries: Map<string, Entry>, prefix: string) {
  return [...entries.values()].filter((entry) => entry.filename.startsWith(prefix));
}

function normalizeDirPrefix(path: string) {
  return path.endsWith("/") ? path : `${path}/`;
}

function relativeZipPath(prefix: string, filename: string) {
  const childPath = filename.slice(prefix.length);
  if (!childPath || childPath.includes("..") || childPath.startsWith("/") || childPath.startsWith("\\")) {
    return undefined;
  }

  return childPath;
}

function toZipPath(path: string) {
  return path.split(/[/\\]+/).join("/");
}

function hostFromUrl(url: string) {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return url.trim().toLowerCase();
  }
}

function normalizeWebStateUrl(value?: string) {
  const fallback = "https://imported.local/";
  if (!value) {
    return fallback;
  }

  try {
    const parsed = new URL(value);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      return parsed.toString();
    }
  } catch {
    return fallback;
  }

  return fallback;
}

function isSessionSyncManifest(manifest: SessionSyncManifest | ChromeSyncPackageManifest): manifest is SessionSyncManifest {
  return "version" in manifest && manifest.version === manifestVersion && Array.isArray(manifest.sites);
}

function isChromeSyncPackageManifest(manifest: SessionSyncManifest | ChromeSyncPackageManifest): manifest is ChromeSyncPackageManifest {
  return "packageType" in manifest
    && manifest.packageType === chromeSyncPackageType
    && manifest.formatVersion === manifestVersion;
}

function createDefaultExportFileName(site?: Site) {
  const host = site ? hostFromUrl(site.url).replace(/[^a-z0-9.-]+/gi, "-") : "jarvis-session";
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `${host}-${timestamp}${fileExtension}`;
}

function ensureSessionSyncExtension(filePath: string) {
  return filePath.endsWith(fileExtension) ? filePath : `${filePath}${fileExtension}`;
}

function normalizeConflictAction(action: SessionSyncConflictAction | undefined, fallback: SessionSyncConflictAction = "skip") {
  return action === "overwrite-all" ? "overwrite" : action ?? fallback;
}

function createCanceledPreview(): SessionSyncPreviewImportResult {
  return {
    canceled: true,
    encrypted: false,
    sites: [],
    duplicateSiteCount: 0,
    duplicateSessionCount: 0,
    summary: {
      totalSites: 0,
      importableSites: 0,
      totalSessions: 0,
      importableSessions: 0,
    },
  };
}

function createId() {
  if (globalThis.crypto?.randomUUID) {
    return globalThis.crypto.randomUUID();
  }

  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function getPendingSessionTempDir(tempDir: string, sourceSiteId: string, sourceSessionId: string) {
  return join(tempDir, "sites", sourceSiteId, "sessions", sourceSessionId);
}

async function pathExists(path: string) {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function isPathInside(root: string, targetPath: string) {
  const childPath = relative(root, targetPath);
  return Boolean(childPath) && !childPath.startsWith("..") && !isAbsolute(childPath);
}
