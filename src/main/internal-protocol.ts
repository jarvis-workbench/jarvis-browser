import { app, protocol, type Session } from "electron";
import { readFile } from "node:fs/promises";
import { extname, join, relative, resolve } from "node:path";
import type { BrowserInternalPageId } from "../shared/types";
import { dataPaths } from "./data-paths";

export const internalPageProtocol = "jarvis-browser";
export const internalPageOrigin = `${internalPageProtocol}://`;

export const newTabInternalPageId = "newtab";
export const downloadsInternalPageId = "downloads";
export const settingsInternalPageId = "settings";
export const extensionsInternalPageId = "extensions";
export const jarvisScriptInternalPageId = "jarvis-script";
export const historyInternalPageId = "history";
export const clearBrowsingDataInternalPageId = "clear-browsing-data";
export const errorInternalPageId = "error";
export const overlayInternalPageId = "overlay";
export const assetsInternalPageId = "assets";

export const internalPageIds = [
  newTabInternalPageId,
  downloadsInternalPageId,
  settingsInternalPageId,
  extensionsInternalPageId,
  jarvisScriptInternalPageId,
  historyInternalPageId,
  clearBrowsingDataInternalPageId,
] as const satisfies BrowserInternalPageId[];

export type InternalPageId = typeof internalPageIds[number];

const internalPageIdSet = new Set<string>(internalPageIds);

export const internalPageUrls = {
  [newTabInternalPageId]: createInternalPageUrl(newTabInternalPageId),
  [downloadsInternalPageId]: createInternalPageUrl(downloadsInternalPageId),
  [settingsInternalPageId]: createInternalPageUrl(settingsInternalPageId),
  [extensionsInternalPageId]: createInternalPageUrl(extensionsInternalPageId),
  [jarvisScriptInternalPageId]: createInternalPageUrl(jarvisScriptInternalPageId),
  [historyInternalPageId]: createInternalPageUrl(historyInternalPageId),
  [clearBrowsingDataInternalPageId]: createInternalPageUrl(clearBrowsingDataInternalPageId),
} satisfies Record<InternalPageId, string>;

export function createInternalPageUrl(pageId: InternalPageId) {
  return `${internalPageOrigin}${pageId}`;
}

export function createInternalErrorPageUrl(info: { kind: "network" | "http"; url: string; errorText: string; statusCode?: number }) {
  const params = new URLSearchParams({
    kind: info.kind,
    url: info.url,
    errorText: info.errorText,
  });
  if (info.statusCode !== undefined) {
    params.set("statusCode", String(info.statusCode));
  }

  return `${internalPageOrigin}${errorInternalPageId}?${params.toString()}`;
}

export function createSiteFaviconInternalUrl(siteId: string) {
  return `${internalPageOrigin}${assetsInternalPageId}/site-favicon/${encodeURIComponent(siteId)}`;
}

export function isInternalPageId(value: string): value is InternalPageId {
  return internalPageIdSet.has(value);
}

export function parseInternalPageUrl(url: string) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== `${internalPageProtocol}:`) {
      return undefined;
    }

    return isInternalPageId(parsed.hostname) ? parsed.hostname : undefined;
  } catch {
    return undefined;
  }
}

export function isInternalPageUrl(url: string) {
  return parseInternalPageUrl(url) !== undefined;
}

export function isInternalErrorPageUrl(url: string) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === `${internalPageProtocol}:` && parsed.hostname === errorInternalPageId;
  } catch {
    return false;
  }
}

protocol.registerSchemesAsPrivileged([
  {
    scheme: internalPageProtocol,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
    },
  },
]);

const registeredSessions = new WeakSet<Session>();

export function registerInternalProtocol() {
  if (protocol.isProtocolHandled(internalPageProtocol)) {
    return;
  }

  protocol.handle(internalPageProtocol, handleInternalRequest);
}

export function registerInternalProtocolForSession(targetSession: Session) {
  if (registeredSessions.has(targetSession)) {
    return;
  }

  if (targetSession.protocol.isProtocolHandled(internalPageProtocol)) {
    registeredSessions.add(targetSession);
    return;
  }

  targetSession.protocol.handle(internalPageProtocol, handleInternalRequest);
  registeredSessions.add(targetSession);
}

async function handleInternalRequest(request: Request) {
  const requestUrl = new URL(request.url);
  if (requestUrl.hostname === assetsInternalPageId) {
    return handleAssetRequest(requestUrl);
  }

  if (requestUrl.hostname === errorInternalPageId) {
    return htmlResponse(await readErrorPageHtml());
  }

  if (requestUrl.hostname === overlayInternalPageId) {
    return htmlResponse(await readOverlayPageHtml());
  }

  if (isInternalPageId(requestUrl.hostname)) {
    if (isDevRendererAssetRequest(requestUrl)) {
      return proxyDevRendererRequest(requestUrl);
    }

    if (isRendererAssetRequest(requestUrl)) {
      return handleRendererAssetRequest(requestUrl);
    }

    return htmlResponse(await readRendererHtml(requestUrl.hostname));
  }

  return new Response("Not Found", { status: 404 });
}

async function handleAssetRequest(requestUrl: URL) {
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
  const bytes = await readFile(faviconPath).catch(() => undefined);
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

async function readFaviconMetadata(siteId: string) {
  try {
    return JSON.parse(await readFile(dataPaths.sites.faviconMetadataFile(siteId), "utf8")) as { faviconPath?: string };
  } catch {
    return undefined;
  }
}

async function readRendererHtml(pageId: InternalPageId) {
  let html = await readFile(getRendererIndexPath(), "utf8");
  if (!app.isPackaged && process.env.VITE_DEV_SERVER_URL) {
    html = html.replace(
      '<script type="module" src="/main.ts"></script>',
      '<script type="module" src="/@vite/client"></script><script type="module" src="/main.ts"></script>',
    );
  }

  return html.replace(
    "</head>",
    `<script>window.__JARVIS_INTERNAL_PAGE__=${JSON.stringify(pageId)}</script></head>`,
  );
}

function isDevRendererAssetRequest(requestUrl: URL) {
  return !app.isPackaged
    && Boolean(process.env.VITE_DEV_SERVER_URL)
    && requestUrl.pathname !== ""
    && requestUrl.pathname !== "/";
}

async function proxyDevRendererRequest(requestUrl: URL) {
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

async function handleRendererAssetRequest(requestUrl: URL) {
  const rendererRoot = getRendererRootPath();
  const assetPath = resolve(rendererRoot, decodeURIComponent(requestUrl.pathname.slice(1)));
  const relativeAssetPath = relative(rendererRoot, assetPath);
  if (
    relativeAssetPath.startsWith("..")
    || relativeAssetPath === ""
    || isAbsolutePath(relativeAssetPath)
  ) {
    return new Response("Bad Request", { status: 400 });
  }

  const bytes = await readFile(assetPath).catch(() => undefined);
  if (!bytes) {
    return new Response("Not Found", { status: 404 });
  }

  return new Response(bytes, {
    headers: {
      "content-type": contentTypeFromPath(assetPath),
      "cache-control": app.isPackaged ? "max-age=31536000" : "no-store",
    },
  });
}

function isRendererAssetRequest(requestUrl: URL) {
  return requestUrl.pathname !== "" && requestUrl.pathname !== "/";
}

function isAbsolutePath(filePath: string) {
  return resolve(filePath) === filePath;
}

function getRendererRootPath() {
  if (!app.isPackaged) {
    return join(app.getAppPath(), "src", "renderer");
  }

  return join(__dirname, "../renderer");
}

function getRendererIndexPath() {
  return join(getRendererRootPath(), "index.html");
}

function readErrorPageHtml() {
  return readInternalPageHtml("error");
}

function readOverlayPageHtml() {
  return readInternalPageHtml("overlay");
}

async function readInternalPageHtml(pageName: "error" | "overlay") {
  const fileName = `${pageName}.html`;
  const candidates = app.isPackaged
    ? [join(process.resourcesPath, "internal-pages", fileName)]
    : [
      join(app.getAppPath(), "src", "internal-pages", fileName),
      join(__dirname, "../../src/internal-pages", fileName),
    ];

  for (const candidate of candidates) {
    const html = await readFile(candidate, "utf8").catch((error: unknown) => {
      if (isNodeError(error) && error.code === "ENOENT") {
        return undefined;
      }
      throw error;
    });

    if (html !== undefined) {
      return html;
    }
  }

  const missingPaths = candidates.join(", ");
  console.error(`[internal-protocol] ${fileName} not found. Tried: ${missingPaths}`);
  return fallbackInternalPageHtml(pageName, missingPaths);
}

function htmlResponse(html: string) {
  return new Response(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function fallbackInternalPageHtml(pageName: "error" | "overlay", missingPaths: string) {
  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8">
    <title>Jarvis Browser</title>
    <style>
      body { margin: 0; padding: 16px; color: #202124; background: #fff; font: 13px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
      strong { display: block; margin-bottom: 8px; font-size: 14px; }
      code { display: block; white-space: pre-wrap; word-break: break-word; color: #5f6368; }
    </style>
  </head>
  <body>
    <strong>Internal page failed to load: ${escapeHtml(pageName)}</strong>
    <code>${escapeHtml(missingPaths)}</code>
  </body>
</html>`;
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (character) => {
    switch (character) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case "\"":
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function contentTypeFromPath(filePath: string) {
  const extension = extname(filePath).toLowerCase();
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
  if (extension === ".js" || extension === ".mjs") {
    return "text/javascript";
  }
  if (extension === ".css") {
    return "text/css";
  }
  if (extension === ".html") {
    return "text/html; charset=utf-8";
  }
  if (extension === ".json") {
    return "application/json";
  }
  if (extension === ".woff") {
    return "font/woff";
  }
  if (extension === ".woff2") {
    return "font/woff2";
  }
  return "image/x-icon";
}
