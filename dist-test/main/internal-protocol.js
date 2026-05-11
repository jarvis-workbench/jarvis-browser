"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.internalPageUrls = exports.internalPageIds = exports.assetsInternalPageId = exports.overlayInternalPageId = exports.errorInternalPageId = exports.clearBrowsingDataInternalPageId = exports.historyInternalPageId = exports.jarvisScriptInternalPageId = exports.extensionsInternalPageId = exports.settingsInternalPageId = exports.downloadsInternalPageId = exports.newTabInternalPageId = exports.internalPageOrigin = exports.internalPageProtocol = void 0;
exports.createInternalPageUrl = createInternalPageUrl;
exports.createInternalErrorPageUrl = createInternalErrorPageUrl;
exports.createSiteFaviconInternalUrl = createSiteFaviconInternalUrl;
exports.isInternalPageId = isInternalPageId;
exports.parseInternalPageUrl = parseInternalPageUrl;
exports.isInternalPageUrl = isInternalPageUrl;
exports.isInternalErrorPageUrl = isInternalErrorPageUrl;
exports.registerInternalProtocol = registerInternalProtocol;
exports.registerInternalProtocolForSession = registerInternalProtocolForSession;
const electron_1 = require("electron");
const promises_1 = require("node:fs/promises");
const node_path_1 = require("node:path");
const data_paths_1 = require("./data-paths");
exports.internalPageProtocol = "jarvis-browser";
exports.internalPageOrigin = `${exports.internalPageProtocol}://`;
exports.newTabInternalPageId = "newtab";
exports.downloadsInternalPageId = "downloads";
exports.settingsInternalPageId = "settings";
exports.extensionsInternalPageId = "extensions";
exports.jarvisScriptInternalPageId = "jarvis-script";
exports.historyInternalPageId = "history";
exports.clearBrowsingDataInternalPageId = "clear-browsing-data";
exports.errorInternalPageId = "error";
exports.overlayInternalPageId = "overlay";
exports.assetsInternalPageId = "assets";
exports.internalPageIds = [
    exports.newTabInternalPageId,
    exports.downloadsInternalPageId,
    exports.settingsInternalPageId,
    exports.extensionsInternalPageId,
    exports.jarvisScriptInternalPageId,
    exports.historyInternalPageId,
    exports.clearBrowsingDataInternalPageId,
];
const internalPageIdSet = new Set(exports.internalPageIds);
exports.internalPageUrls = {
    [exports.newTabInternalPageId]: createInternalPageUrl(exports.newTabInternalPageId),
    [exports.downloadsInternalPageId]: createInternalPageUrl(exports.downloadsInternalPageId),
    [exports.settingsInternalPageId]: createInternalPageUrl(exports.settingsInternalPageId),
    [exports.extensionsInternalPageId]: createInternalPageUrl(exports.extensionsInternalPageId),
    [exports.jarvisScriptInternalPageId]: createInternalPageUrl(exports.jarvisScriptInternalPageId),
    [exports.historyInternalPageId]: createInternalPageUrl(exports.historyInternalPageId),
    [exports.clearBrowsingDataInternalPageId]: createInternalPageUrl(exports.clearBrowsingDataInternalPageId),
};
function createInternalPageUrl(pageId) {
    return `${exports.internalPageOrigin}${pageId}`;
}
function createInternalErrorPageUrl(info) {
    const params = new URLSearchParams({
        kind: info.kind,
        url: info.url,
        errorText: info.errorText,
    });
    if (info.statusCode !== undefined) {
        params.set("statusCode", String(info.statusCode));
    }
    return `${exports.internalPageOrigin}${exports.errorInternalPageId}?${params.toString()}`;
}
function createSiteFaviconInternalUrl(siteId) {
    return `${exports.internalPageOrigin}${exports.assetsInternalPageId}/site-favicon/${encodeURIComponent(siteId)}`;
}
function isInternalPageId(value) {
    return internalPageIdSet.has(value);
}
function parseInternalPageUrl(url) {
    try {
        const parsed = new URL(url);
        if (parsed.protocol !== `${exports.internalPageProtocol}:`) {
            return undefined;
        }
        return isInternalPageId(parsed.hostname) ? parsed.hostname : undefined;
    }
    catch {
        return undefined;
    }
}
function isInternalPageUrl(url) {
    return parseInternalPageUrl(url) !== undefined;
}
function isInternalErrorPageUrl(url) {
    try {
        const parsed = new URL(url);
        return parsed.protocol === `${exports.internalPageProtocol}:` && parsed.hostname === exports.errorInternalPageId;
    }
    catch {
        return false;
    }
}
electron_1.protocol.registerSchemesAsPrivileged([
    {
        scheme: exports.internalPageProtocol,
        privileges: {
            standard: true,
            secure: true,
            supportFetchAPI: true,
            corsEnabled: true,
        },
    },
]);
const registeredSessions = new WeakSet();
function registerInternalProtocol() {
    electron_1.protocol.handle(exports.internalPageProtocol, handleInternalRequest);
}
function registerInternalProtocolForSession(targetSession) {
    if (registeredSessions.has(targetSession)) {
        return;
    }
    targetSession.protocol.handle(exports.internalPageProtocol, handleInternalRequest);
    registeredSessions.add(targetSession);
}
async function handleInternalRequest(request) {
    const requestUrl = new URL(request.url);
    if (requestUrl.hostname === exports.assetsInternalPageId) {
        return handleAssetRequest(requestUrl);
    }
    if (requestUrl.hostname === exports.errorInternalPageId) {
        return htmlResponse(await readErrorPageHtml());
    }
    if (requestUrl.hostname === exports.overlayInternalPageId) {
        return htmlResponse(await readOverlayPageHtml());
    }
    if (isInternalPageId(requestUrl.hostname)) {
        if (isDevRendererAssetRequest(requestUrl)) {
            return proxyDevRendererRequest(requestUrl);
        }
        return htmlResponse(await readRendererHtml(requestUrl.hostname));
    }
    return new Response("Not Found", { status: 404 });
}
async function handleAssetRequest(requestUrl) {
    const pathParts = requestUrl.pathname.split("/").filter(Boolean);
    if (pathParts[0] !== "site-favicon" || !pathParts[1]) {
        return new Response("Not Found", { status: 404 });
    }
    const siteId = decodeURIComponent(pathParts[1]);
    if (siteId.includes("/") || siteId.includes("\\")) {
        return new Response("Bad Request", { status: 400 });
    }
    const metadata = await readFaviconMetadata(siteId);
    if (!metadata?.faviconPath) {
        return new Response("Not Found", { status: 404 });
    }
    const faviconPath = metadata.faviconPath.replace(/^file:\/\//, "");
    const bytes = await (0, promises_1.readFile)(faviconPath).catch(() => undefined);
    if (!bytes) {
        return new Response("Not Found", { status: 404 });
    }
    return new Response(bytes, {
        headers: {
            "content-type": contentTypeFromPath(faviconPath),
            "cache-control": "no-store",
        },
    });
}
async function readFaviconMetadata(siteId) {
    try {
        return JSON.parse(await (0, promises_1.readFile)(data_paths_1.dataPaths.sites.faviconMetadataFile(siteId), "utf8"));
    }
    catch {
        return undefined;
    }
}
async function readRendererHtml(pageId) {
    let html = await (0, promises_1.readFile)(getRendererIndexPath(), "utf8");
    if (!electron_1.app.isPackaged && process.env.VITE_DEV_SERVER_URL) {
        html = html.replace('<script type="module" src="/main.ts"></script>', '<script type="module" src="/@vite/client"></script><script type="module" src="/main.ts"></script>');
    }
    return html.replace("</head>", `<script>window.__JARVIS_INTERNAL_PAGE__=${JSON.stringify(pageId)}</script></head>`);
}
function isDevRendererAssetRequest(requestUrl) {
    return !electron_1.app.isPackaged
        && Boolean(process.env.VITE_DEV_SERVER_URL)
        && requestUrl.pathname !== ""
        && requestUrl.pathname !== "/";
}
async function proxyDevRendererRequest(requestUrl) {
    const devServerUrl = new URL(process.env.VITE_DEV_SERVER_URL ?? "");
    const targetUrl = new URL(`${requestUrl.pathname}${requestUrl.search}`, devServerUrl);
    const upstream = await fetch(targetUrl);
    const headers = new Headers(upstream.headers);
    headers.delete("content-encoding");
    headers.delete("content-length");
    headers.delete("transfer-encoding");
    return new Response(await upstream.arrayBuffer(), {
        status: upstream.status,
        statusText: upstream.statusText,
        headers,
    });
}
function getRendererIndexPath() {
    if (!electron_1.app.isPackaged) {
        return (0, node_path_1.join)(electron_1.app.getAppPath(), "src", "renderer", "index.html");
    }
    return (0, node_path_1.join)(__dirname, "../renderer/index.html");
}
function readErrorPageHtml() {
    if (!electron_1.app.isPackaged) {
        return (0, promises_1.readFile)((0, node_path_1.join)(electron_1.app.getAppPath(), "src", "internal-pages", "error.html"), "utf8");
    }
    return (0, promises_1.readFile)((0, node_path_1.join)(process.resourcesPath, "internal-pages", "error.html"), "utf8");
}
function readOverlayPageHtml() {
    if (!electron_1.app.isPackaged) {
        return (0, promises_1.readFile)((0, node_path_1.join)(electron_1.app.getAppPath(), "src", "internal-pages", "overlay.html"), "utf8");
    }
    return (0, promises_1.readFile)((0, node_path_1.join)(process.resourcesPath, "internal-pages", "overlay.html"), "utf8");
}
function htmlResponse(html) {
    return new Response(html, {
        headers: {
            "content-type": "text/html; charset=utf-8",
            "cache-control": "no-store",
        },
    });
}
function contentTypeFromPath(filePath) {
    const extension = (0, node_path_1.extname)(filePath).toLowerCase();
    if (extension === ".png") {
        return "image/png";
    }
    if (extension === ".jpg" || extension === ".jpeg") {
        return "image/jpeg";
    }
    if (extension === ".svg") {
        return "image/svg+xml";
    }
    if (extension === ".webp") {
        return "image/webp";
    }
    return "image/x-icon";
}
