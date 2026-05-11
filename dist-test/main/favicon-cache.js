"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.cacheSiteFaviconDataUrl = cacheSiteFaviconDataUrl;
exports.cacheSiteFaviconBytes = cacheSiteFaviconBytes;
const promises_1 = require("node:fs/promises");
const data_paths_1 = require("./data-paths");
async function cacheSiteFaviconDataUrl(siteId, faviconUrl) {
    if (!/^data:/i.test(faviconUrl)) {
        throw new Error("图标不是 data URL");
    }
    return cacheDataFavicon(siteId, faviconUrl);
}
async function cacheSiteFaviconBytes(siteId, faviconUrl, bytes, contentType) {
    if (!bytes.length) {
        throw new Error("图标内容为空");
    }
    const extension = extensionFromContentType(contentType) ?? extensionFromUrl(faviconUrl) ?? extensionFromBytes(bytes);
    if (!extension) {
        throw new Error("无法识别图标类型");
    }
    const faviconPath = data_paths_1.dataPaths.sites.faviconFile(siteId, extension);
    await (0, promises_1.mkdir)(data_paths_1.dataPaths.sites.faviconRoot(siteId), { recursive: true });
    await (0, promises_1.writeFile)(faviconPath, bytes);
    await (0, promises_1.writeFile)(data_paths_1.dataPaths.sites.faviconMetadataFile(siteId), `${JSON.stringify({ faviconUrl, faviconPath, cachedAt: new Date().toISOString() }, null, 2)}\n`, "utf8");
    return faviconPath;
}
function extensionFromContentType(contentType) {
    const normalized = contentType?.split(";")[0]?.trim().toLowerCase();
    if (normalized === "image/png") {
        return ".png";
    }
    if (normalized === "image/jpeg") {
        return ".jpg";
    }
    if (normalized === "image/svg+xml") {
        return ".svg";
    }
    if (normalized === "image/webp") {
        return ".webp";
    }
    if (normalized === "image/x-icon" || normalized === "image/vnd.microsoft.icon") {
        return ".ico";
    }
    return undefined;
}
function extensionFromUrl(faviconUrl) {
    try {
        const pathname = new URL(faviconUrl).pathname.toLowerCase();
        if (pathname.endsWith(".png")) {
            return ".png";
        }
        if (pathname.endsWith(".jpg") || pathname.endsWith(".jpeg")) {
            return ".jpg";
        }
        if (pathname.endsWith(".svg")) {
            return ".svg";
        }
        if (pathname.endsWith(".webp")) {
            return ".webp";
        }
        if (pathname.endsWith(".ico")) {
            return ".ico";
        }
    }
    catch {
        return undefined;
    }
    return undefined;
}
function extensionFromBytes(bytes) {
    if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
        return ".png";
    }
    if (bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) {
        return ".jpg";
    }
    if (bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") {
        return ".webp";
    }
    if (bytes.subarray(0, 4).equals(Buffer.from([0x00, 0x00, 0x01, 0x00]))) {
        return ".ico";
    }
    const head = bytes.subarray(0, 256).toString("utf8").trimStart().toLowerCase();
    if (head.startsWith("<svg") || head.startsWith("<?xml")) {
        return ".svg";
    }
    return undefined;
}
async function cacheDataFavicon(siteId, faviconUrl) {
    const match = faviconUrl.match(/^data:([^;,]+)?((?:;[^,]*)?),(.*)$/i);
    if (!match) {
        throw new Error("data 图标格式无效");
    }
    const contentType = match[1] || "image/png";
    const isBase64 = match[2]?.toLowerCase().includes(";base64");
    const data = match[3] ?? "";
    const buffer = isBase64 ? Buffer.from(data, "base64") : Buffer.from(decodeURIComponent(data));
    const extension = extensionFromContentType(contentType);
    if (!extension) {
        throw new Error("无法识别 data 图标类型");
    }
    const faviconPath = data_paths_1.dataPaths.sites.faviconFile(siteId, extension);
    await (0, promises_1.mkdir)(data_paths_1.dataPaths.sites.faviconRoot(siteId), { recursive: true });
    await (0, promises_1.writeFile)(faviconPath, buffer);
    await (0, promises_1.writeFile)(data_paths_1.dataPaths.sites.faviconMetadataFile(siteId), `${JSON.stringify({ faviconUrl, faviconPath, cachedAt: new Date().toISOString() }, null, 2)}\n`, "utf8");
    return faviconPath;
}
