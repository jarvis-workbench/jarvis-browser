import http, { type IncomingMessage, type ServerResponse } from "node:http";
import type {
  AutomationBridgeSettings,
  AutomationBridgeStatus,
  AutomationDomQueryInput,
  AutomationDomSnapshotInput,
  AutomationEvaluateInput,
  AutomationTelegramInput,
} from "../shared/types";
import { BrowserHost } from "./browser-host";

const host = "127.0.0.1";
const maxBodyBytes = 1024 * 1024;

export class AutomationBridge {
  private server?: http.Server;
  private settings: AutomationBridgeSettings;
  private lastError?: string;

  constructor(
    private readonly browserHost: BrowserHost,
    initialSettings: AutomationBridgeSettings,
  ) {
    this.settings = initialSettings;
  }

  async applySettings(settings: AutomationBridgeSettings) {
    const previousPort = this.settings.port;
    const wasRunning = Boolean(this.server);
    this.settings = settings;
    this.lastError = undefined;

    if (!settings.enabled) {
      await this.stop();
      return this.getStatus();
    }

    if (wasRunning && previousPort === settings.port) {
      return this.getStatus();
    }

    await this.stop();
    await this.start();
    return this.getStatus();
  }

  getStatus(): AutomationBridgeStatus {
    return {
      ...this.settings,
      running: Boolean(this.server),
      origin: this.origin,
      lastError: this.lastError,
    };
  }

  async close() {
    await this.stop();
  }

  private get origin() {
    return `http://${host}:${this.settings.port}`;
  }

  private async start() {
    const server = http.createServer((request, response) => {
      void this.handleRequest(request, response);
    });

    try {
      await new Promise<void>((resolve, reject) => {
        const handleError = (error: Error) => {
          reject(error);
        };
        server.once("error", handleError);
        server.listen(this.settings.port, host, () => {
          server.off("error", handleError);
          resolve();
        });
      });
      server.on("error", (error) => {
        this.lastError = error.message;
      });
      this.server = server;
      console.info(`[automation-bridge] listening on ${this.origin}`);
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      server.close();
      console.error("[automation-bridge] start failed", error);
    }
  }

  private async stop() {
    const server = this.server;
    this.server = undefined;
    if (!server) {
      return;
    }

    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  }

  private async handleRequest(request: IncomingMessage, response: ServerResponse) {
    try {
      if (request.method === "OPTIONS") {
        this.sendJson(response, 204, undefined);
        return;
      }

      const requestUrl = new URL(request.url || "/", this.origin);
      if (!this.isAuthorized(request, requestUrl)) {
        this.sendJson(response, 401, { error: "Automation token is required" });
        return;
      }

      const result = await this.route(request, requestUrl);
      this.sendJson(response, 200, result);
    } catch (error) {
      const statusCode = error instanceof HttpError ? error.statusCode : 500;
      this.sendJson(response, statusCode, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async route(request: IncomingMessage, requestUrl: URL) {
    if (request.method === "GET" && requestUrl.pathname === "/status") {
      return this.getStatus();
    }

    if (request.method === "GET" && requestUrl.pathname === "/state") {
      return {
        bridge: this.getStatus(),
        activeTab: this.browserHost.getAutomationActiveTab(),
        tabs: this.browserHost.listAutomationTabs(),
      };
    }

    if (request.method === "GET" && requestUrl.pathname === "/tabs") {
      return {
        activeTab: this.browserHost.getAutomationActiveTab(),
        tabs: this.browserHost.listAutomationTabs(),
      };
    }

    if (request.method === "POST" && requestUrl.pathname === "/eval") {
      const body = await readJsonBody<AutomationEvaluateInput>(request);
      if (typeof body.code !== "string" || !body.code.trim()) {
        throw new HttpError(400, "code is required");
      }
      return this.browserHost.evaluateAutomation(body);
    }

    if (request.method === "POST" && requestUrl.pathname === "/dom/query") {
      const body = await readJsonBody<AutomationDomQueryInput>(request);
      if (typeof body.selector !== "string" || !body.selector.trim()) {
        throw new HttpError(400, "selector is required");
      }
      return this.browserHost.queryAutomationDom(body);
    }

    if (request.method === "POST" && requestUrl.pathname === "/dom/snapshot") {
      const body = await readJsonBody<AutomationDomSnapshotInput>(request);
      return this.browserHost.snapshotAutomationDom(body);
    }

    if (request.method === "POST" && requestUrl.pathname === "/tg") {
      const body = await readJsonBody<AutomationTelegramInput>(request);
      return this.browserHost.runTelegramAutomation(body);
    }

    throw new HttpError(404, "Route not found");
  }

  private isAuthorized(request: IncomingMessage, requestUrl: URL) {
    const authorization = request.headers.authorization || "";
    const bearerToken = authorization.match(/^Bearer\s+(.+)$/i)?.[1];
    const headerToken = request.headers["x-jarvis-token"];
    const queryToken = requestUrl.searchParams.get("token");
    const token = bearerToken || (Array.isArray(headerToken) ? headerToken[0] : headerToken) || queryToken;
    return Boolean(token && token === this.settings.token);
  }

  private sendJson(response: ServerResponse, statusCode: number, payload: unknown) {
    response.statusCode = statusCode;
    response.setHeader("content-type", "application/json; charset=utf-8");
    response.setHeader("cache-control", "no-store");
    response.end(payload === undefined ? "" : JSON.stringify(payload));
  }
}

class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

async function readJsonBody<T>(request: IncomingMessage): Promise<T> {
  let size = 0;
  const chunks: Buffer[] = [];

  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > maxBodyBytes) {
      throw new HttpError(413, "Request body is too large");
    }
    chunks.push(buffer);
  }

  if (!chunks.length) {
    return {} as T;
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as T;
  } catch {
    throw new HttpError(400, "Request body must be valid JSON");
  }
}
