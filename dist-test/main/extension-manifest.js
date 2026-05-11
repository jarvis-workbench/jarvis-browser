"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createExtensionFromPath = createExtensionFromPath;
exports.readExtensionManifestMetadata = readExtensionManifestMetadata;
const promises_1 = require("node:fs/promises");
const node_path_1 = require("node:path");
async function createExtensionFromPath(extensionPath) {
    const metadata = await readExtensionManifestMetadata(extensionPath);
    const timestamp = new Date().toISOString();
    return {
        id: stablePathId(extensionPath),
        name: metadata.name || (0, node_path_1.basename)(extensionPath),
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
async function readExtensionManifestMetadata(extensionPath) {
    const manifest = await readManifest(extensionPath);
    return {
        name: manifest.name || (0, node_path_1.basename)(extensionPath),
        version: manifest.version || "unknown",
        permissions: [...(manifest.permissions ?? []), ...(manifest.host_permissions ?? [])],
        action: resolveExtensionAction(extensionPath, manifest),
        icon: resolveExtensionIcon(extensionPath, manifest.icons),
    };
}
async function readManifest(extensionPath) {
    const manifest = JSON.parse(await (0, promises_1.readFile)((0, node_path_1.join)(extensionPath, "manifest.json"), "utf8"));
    if (!manifest.name) {
        throw new Error("manifest.json 缺少名称");
    }
    return manifest;
}
function resolveExtensionIcon(extensionPath, icons) {
    return resolveIconPath(extensionPath, icons);
}
function resolveExtensionAction(extensionPath, manifest) {
    const action = manifest.action ?? manifest.browser_action;
    const defaultPopup = action?.default_popup?.trim();
    if (!defaultPopup) {
        return undefined;
    }
    return {
        defaultPopup,
        defaultTitle: action?.default_title || manifest.name,
        icon: resolveIconPath(extensionPath, action?.default_icon),
    };
}
function resolveIconPath(extensionPath, icon) {
    if (!icon) {
        return undefined;
    }
    const iconPath = typeof icon === "string"
        ? icon
        : Object.entries(icon).sort((a, b) => Number(b[0]) - Number(a[0]))[0]?.[1];
    return iconPath ? (0, node_path_1.join)(extensionPath, iconPath) : undefined;
}
function stablePathId(path) {
    let hash = 0;
    for (let index = 0; index < path.length; index += 1) {
        hash = (hash * 31 + path.charCodeAt(index)) >>> 0;
    }
    return `path-${hash.toString(36)}`;
}
