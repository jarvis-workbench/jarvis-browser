import { readFile, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import type { JarvisScript, JarvisScriptManifest, JarvisScriptScope } from "../../shared/types";

type ManifestRecord = Record<string, unknown>;

export async function createJarvisScriptFromPath(
  sourcePath: string,
  scope: JarvisScriptScope,
  siteId?: string,
): Promise<JarvisScript> {
  const manifest = await readJarvisScriptManifest(sourcePath);
  const timestamp = new Date().toISOString();
  const id = manifest.id?.trim() || stablePathId(sourcePath);

  return {
    id,
    name: manifest.name,
    version: manifest.version || "0.0.0",
    description: manifest.description,
    scope,
    siteId,
    path: sourcePath,
    manifest: {
      ...manifest,
      id,
      enabled: manifest.enabled ?? true,
    },
    runtimeState: {
      enabled: manifest.enabled ?? true,
    },
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

async function readJarvisScriptManifest(sourcePath: string) {
  const sourceStat = await stat(sourcePath).catch(() => undefined);
  if (!sourceStat?.isDirectory()) {
    throw new Error("请选择 Jarvis Script 目录");
  }

  const manifestPath = join(sourcePath, "jarvis-script.json");
  const rawText = await readFile(manifestPath, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") {
      throw new Error("Jarvis Script 目录缺少 jarvis-script.json");
    }
    throw error;
  });
  const raw = JSON.parse(rawText) as ManifestRecord;
  const name = readRequiredString(raw.name, "jarvis-script.json 缺少 name");

  return {
    id: readOptionalString(raw.id),
    name,
    version: readOptionalString(raw.version),
    description: readOptionalString(raw.description),
    enabled: readOptionalBoolean(raw.enabled),
    permissions: readStringArray(raw.permissions),
    monitors: Array.isArray(raw.monitors)
      ? raw.monitors.map((item, index) => readMonitor(item, index))
      : undefined,
    workers: Array.isArray(raw.workers)
      ? raw.workers.map((item, index) => readWorker(item, index))
      : undefined,
    contentScripts: Array.isArray(raw.contentScripts)
      ? raw.contentScripts.map((item, index) => readContentScript(item, index))
      : undefined,
  } satisfies JarvisScriptManifest;
}

function readMonitor(value: unknown, index: number) {
  if (!value || typeof value !== "object") {
    throw new Error(`jarvis-script.json monitors[${index}] 必须是对象`);
  }

  const record = value as ManifestRecord;
  return {
    id: readOptionalString(record.id) || `monitor-${index + 1}`,
    name: readOptionalString(record.name),
    matches: readStringArray(record.matches),
    events: readStringArray(record.events),
  };
}

function readWorker(value: unknown, index: number) {
  if (!value || typeof value !== "object") {
    throw new Error(`jarvis-script.json workers[${index}] 必须是对象`);
  }

  const record = value as ManifestRecord;
  return {
    id: readOptionalString(record.id) || `worker-${index + 1}`,
    entry: readRequiredString(record.entry, `jarvis-script.json workers[${index}].entry 不能为空`),
  };
}

function readContentScript(value: unknown, index: number) {
  if (!value || typeof value !== "object") {
    throw new Error(`jarvis-script.json contentScripts[${index}] 必须是对象`);
  }

  const record = value as ManifestRecord;
  return {
    id: readOptionalString(record.id) || `content-script-${index + 1}`,
    matches: readStringArray(record.matches),
    js: readStringArray(record.js),
    css: readStringArray(record.css),
  };
}

function readRequiredString(value: unknown, message: string) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(message);
  }

  return value.trim();
}

function readOptionalString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readOptionalBoolean(value: unknown) {
  return typeof value === "boolean" ? value : undefined;
}

function readStringArray(value: unknown) {
  if (value === undefined) {
    return undefined;
  }

  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error("jarvis-script.json 数组字段只能包含字符串");
  }

  return value.map((item) => item.trim()).filter(Boolean);
}

function stablePathId(path: string) {
  const source = basename(path) || path;
  let hash = 0;
  for (let index = 0; index < path.length; index += 1) {
    hash = (hash * 31 + path.charCodeAt(index)) >>> 0;
  }

  return `${source}-${hash.toString(36)}`;
}
