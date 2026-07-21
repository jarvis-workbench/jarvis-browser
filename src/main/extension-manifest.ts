import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { SiteExtension } from "../shared/types";

type ExtensionManifest = {
  name?: string;
  version?: string;
  permissions?: string[];
  host_permissions?: string[];
  icons?: Record<string, string>;
  action?: ExtensionActionManifest;
  browser_action?: ExtensionActionManifest;
  jarvis?: {
    popup?: {
      width?: number;
      height?: number;
    };
  };
};

type ExtensionActionManifest = {
  default_popup?: string;
  default_title?: string;
  default_icon?: string | Record<string, string>;
  default_popup_width?: number;
  default_popup_height?: number;
  popup_width?: number;
  popup_height?: number;
};

export async function createExtensionFromPath(extensionPath: string): Promise<SiteExtension> {
  const metadata = await readExtensionManifestMetadata(extensionPath);
  const timestamp = new Date().toISOString();
  return {
    id: stablePathId(extensionPath),
    name: metadata.name || basename(extensionPath),
    version: metadata.version,
    path: extensionPath,
    enabled: true,
    permissions: metadata.permissions,
    action: metadata.action,
    icon: metadata.icon,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

export async function readExtensionManifestMetadata(extensionPath: string) {
  const manifest = await readManifest(extensionPath);
  return {
    name: manifest.name || basename(extensionPath),
    version: manifest.version || "unknown",
    permissions: [...(manifest.permissions ?? []), ...(manifest.host_permissions ?? [])],
    action: resolveExtensionAction(extensionPath, manifest),
    icon: resolveExtensionIcon(extensionPath, manifest.icons),
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
  return resolveIconPath(extensionPath, icons);
}

function resolveExtensionAction(extensionPath: string, manifest: ExtensionManifest) {
  const action = manifest.action ?? manifest.browser_action;
  const defaultPopup = action?.default_popup?.trim();
  if (!defaultPopup) {
    return undefined;
  }

  const popupSize = resolvePopupSize(manifest, action);
  return {
    defaultPopup,
    defaultTitle: action?.default_title || manifest.name,
    icon: resolveIconPath(extensionPath, action?.default_icon),
    popupWidth: popupSize.width,
    popupHeight: popupSize.height,
  };
}

function resolvePopupSize(
  manifest: ExtensionManifest,
  action?: ExtensionActionManifest,
) {
  const width = firstPositiveNumber(
    action?.default_popup_width,
    action?.popup_width,
    manifest.jarvis?.popup?.width,
  );
  const height = firstPositiveNumber(
    action?.default_popup_height,
    action?.popup_height,
    manifest.jarvis?.popup?.height,
  );
  return {
    width,
    height,
  };
}

function firstPositiveNumber(...values: Array<number | undefined>) {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value) && value > 0) {
      return Math.round(value);
    }
  }
  return undefined;
}

function resolveIconPath(extensionPath: string, icon?: string | Record<string, string>) {
  if (!icon) {
    return undefined;
  }

  const iconPath = typeof icon === "string"
    ? icon
    : Object.entries(icon).sort((a, b) => Number(b[0]) - Number(a[0]))[0]?.[1];
  return iconPath ? join(extensionPath, iconPath) : undefined;
}

function stablePathId(path: string) {
  let hash = 0;
  for (let index = 0; index < path.length; index += 1) {
    hash = (hash * 31 + path.charCodeAt(index)) >>> 0;
  }

  return `path-${hash.toString(36)}`;
}
