import { protocol } from "electron";
import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { dataPaths } from "./data-paths";

const assetProtocol = "jarvis-asset";
const assetOrigin = `${assetProtocol}://`;

protocol.registerSchemesAsPrivileged([
  {
    scheme: assetProtocol,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
    },
  },
]);

export function registerAssetProtocol() {
  protocol.handle(assetProtocol, handleAssetRequest);
}

export function createSiteFaviconAssetUrl(siteId: string) {
  return `${assetOrigin}site-favicon/${encodeURIComponent(siteId)}`;
}

async function handleAssetRequest(request: Request) {
  const requestUrl = new URL(request.url);
  if (requestUrl.hostname !== "site-favicon") {
    return new Response("Not Found", { status: 404 });
  }

  const siteId = decodeURIComponent(requestUrl.pathname.replace(/^\//, ""));
  if (!siteId || siteId.includes("/") || siteId.includes("\\")) {
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
  return "image/x-icon";
}
