import { app, protocol, type Session } from "electron";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const errorPageProtocol = "jarvis-error";
const errorPageOrigin = `${errorPageProtocol}://page`;

protocol.registerSchemesAsPrivileged([
  {
    scheme: errorPageProtocol,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
    },
  },
]);

const registeredSessions = new WeakSet<Session>();

export type ErrorPageKind = "network" | "http";

export interface ErrorPageInfo {
  kind: ErrorPageKind;
  url: string;
  errorText: string;
  statusCode?: number;
}

export function registerErrorPageProtocol() {
  protocol.handle(errorPageProtocol, handleErrorPageRequest);
}

export function registerErrorPageProtocolForSession(targetSession: Session) {
  if (registeredSessions.has(targetSession)) {
    return;
  }

  targetSession.protocol.handle(errorPageProtocol, handleErrorPageRequest);
  registeredSessions.add(targetSession);
}

async function handleErrorPageRequest(request: Request) {
    const requestUrl = new URL(request.url);
    if (requestUrl.hostname !== "page") {
      return new Response("Not Found", { status: 404 });
    }

    return new Response(await readErrorPageHtml(), {
      headers: {
        "content-type": "text/html; charset=utf-8",
      },
    });
}

export const isInternalErrorPageUrl = (url: string) => url.startsWith(errorPageOrigin);

export function createErrorPageUrl(info: ErrorPageInfo) {
  const params = new URLSearchParams({
    kind: info.kind,
    url: info.url,
    errorText: info.errorText,
  });
  if (info.statusCode !== undefined) {
    params.set("statusCode", String(info.statusCode));
  }

  return `${errorPageOrigin}?${params.toString()}`;
}

function getErrorPageFilePath() {
  if (!app.isPackaged) {
    return join(app.getAppPath(), "src", "internal-pages", "error.html");
  }

  return join(process.resourcesPath, "internal-pages", "error.html");
}

function readErrorPageHtml() {
  return readFile(getErrorPageFilePath(), "utf8");
}
