import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { SiteExtension } from "../shared/types";

type ExtensionManifest = {
  name?: string;
  version?: string;
  permissions?: string[];
  host_permissions?: string[];
  icons?: Record<string, string>;
};

export async function createExtensionFromPath(extensionPath: string): Promise<SiteExtension> {
  const manifest = await readManifest(extensionPath);
  const timestamp = new Date().toISOString();
  return {
    id: stablePathId(extensionPath),
    name: manifest.name || basename(extensionPath),
    version: manifest.version || "unknown",
    path: extensionPath,
    enabled: true,
    permissions: [...(manifest.permissions ?? []), ...(manifest.host_permissions ?? [])],
    icon: resolveExtensionIcon(extensionPath, manifest.icons),
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

async function readManifest(extensionPath: string) {
  const manifest = JSON.parse(await readFile(join(extensionPath, "manifest.json"), "utf8")) as ExtensionManifest;
  if (!manifest.name) {
    throw new Error("manifest.json 缺少名称");
  }

  return manifest;
}

function resolveExtensionIcon(extensionPath: string, icons?: Record<string, string>) {
  const largest = Object.entries(icons ?? {}).sort((a, b) => Number(b[0]) - Number(a[0]))[0]?.[1];
  return largest ? join(extensionPath, largest) : undefined;
}

function stablePathId(path: string) {
  let hash = 0;
  for (let index = 0; index < path.length; index += 1) {
    hash = (hash * 31 + path.charCodeAt(index)) >>> 0;
  }

  return `path-${hash.toString(36)}`;
}
