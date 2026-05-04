import type { WebContentsView } from "electron";
import type {
  JarvisContentScriptAsset,
  JarvisContentScriptProvider,
  DomMessagePayload,
  JarvisMonitorContext,
  JarvisMonitorEvent,
  JarvisMonitorHandler,
  NetworkRequestPayload,
  NetworkResponseBodyPayload,
  NetworkResponsePayload,
  PageHtmlPayload,
} from "./types";

interface MonitorControllerOptions {
  view: WebContentsView;
  context: Omit<JarvisMonitorContext, "pageUrl">;
  isAlive: () => boolean;
  handleEvent: JarvisMonitorHandler;
  getContentScripts?: JarvisContentScriptProvider;
}

export class JarvisMonitorController {
  private readonly requests = new Map<string, NetworkRequestPayload>();
  private readonly responses = new Map<string, NetworkResponsePayload>();
  private readonly recentResponses = new Map<string, NetworkResponsePayload>();
  private readonly responseBodyRequests = new Set<string>();
  private readonly emittedResponseBodies = new Set<string>();
  private disposed = false;
  private attachedDebugger = false;
  private debuggerListener?: (event: Electron.Event, method: string, params: Record<string, unknown>) => void;

  constructor(private readonly options: MonitorControllerOptions) {}

  async start() {
    const webContents = this.options.view.webContents;

    webContents.on("dom-ready", this.handleDomReady);
    webContents.on("did-finish-load", this.handleDidFinishLoad);
    webContents.on("page-title-updated", this.handlePageTitleUpdated);
    webContents.on("console-message", this.handleConsoleMessage);
    webContents.once("destroyed", () => this.dispose());

    this.debuggerListener = (_event, method, params) => {
      if (method === "Network.requestWillBeSent") {
        void this.handleNetworkRequest(params);
      }
      if (method === "Network.responseReceived") {
        void this.handleNetworkResponse(params);
      }
      if (method === "Network.loadingFinished") {
        void this.handleNetworkLoadingFinished(params);
      }
    };

    if (!webContents.debugger.isAttached()) {
      webContents.debugger.attach("1.3");
      this.attachedDebugger = true;
    }
    webContents.debugger.on("message", this.debuggerListener);
    await webContents.debugger.sendCommand("Network.enable");
    await webContents.debugger.sendCommand("Page.enable").catch(() => undefined);
  }

  dispose() {
    if (this.disposed) {
      return;
    }

    this.disposed = true;
    const webContents = this.options.view.webContents;
    if (!webContents.isDestroyed()) {
      webContents.off("dom-ready", this.handleDomReady);
      webContents.off("did-finish-load", this.handleDidFinishLoad);
      webContents.off("page-title-updated", this.handlePageTitleUpdated);
      webContents.off("console-message", this.handleConsoleMessage);

      if (this.debuggerListener && webContents.debugger.isAttached()) {
        webContents.debugger.removeListener("message", this.debuggerListener);
      }
      if (this.attachedDebugger && webContents.debugger.isAttached()) {
        void webContents.debugger.sendCommand("Network.disable").catch(() => undefined);
        webContents.debugger.detach();
      }
    }

    this.requests.clear();
    this.responses.clear();
    this.recentResponses.clear();
    this.responseBodyRequests.clear();
    this.emittedResponseBodies.clear();
  }

  private readonly handleDidFinishLoad = () => {
    void this.emitPageHtml();
    void this.mountContentScripts();
  };

  private readonly handleDomReady = () => {
    void this.emitPageHtml();
    void this.mountContentScripts();
  };

  private readonly handlePageTitleUpdated = (_event: Electron.Event, title: string) => {
    void this.emit({
      name: "page:title",
      context: this.context(this.currentUrl()),
      payload: { title },
    });
  };

  private readonly handleConsoleMessage = (_event: Electron.Event, _level: number, message: string) => {
    if (!message.startsWith("[jarvis-monitor]")) {
      return;
    }

    const monitorMessage = parseMonitorConsoleMessage(message);
    const payload: DomMessagePayload = {
      channel: typeof monitorMessage?.channel === "string" ? monitorMessage.channel : "console",
      data: monitorMessage?.data ?? message.slice("[jarvis-monitor]".length).trim(),
    };

    void this.emit<DomMessagePayload>({
      name: "dom:message",
      context: this.context(this.currentUrl()),
      payload,
    });
  };

  private async handleNetworkRequest(params: Record<string, unknown>) {
    const requestId = typeof params.requestId === "string" ? params.requestId : undefined;
    const request = params.request as { url?: unknown; method?: unknown } | undefined;
    const type = typeof params.type === "string" ? params.type : undefined;
    const url = typeof request?.url === "string" ? request.url : undefined;
    if (!requestId || !url) {
      return;
    }

    const payload: NetworkRequestPayload = {
      requestId,
      url,
      method: typeof request?.method === "string" ? request.method : undefined,
      resourceType: type,
    };
    this.requests.set(requestId, payload);
    await this.emit({ name: "network:request", context: this.context(this.currentUrl()), payload });
  }

  private async handleNetworkResponse(params: Record<string, unknown>) {
    const requestId = typeof params.requestId === "string" ? params.requestId : undefined;
    const response = params.response as { url?: unknown; status?: unknown; mimeType?: unknown } | undefined;
    const type = typeof params.type === "string" ? params.type : undefined;
    const url = typeof response?.url === "string" ? response.url : undefined;
    if (!requestId || !url) {
      return;
    }

    const payload: NetworkResponsePayload = {
      requestId,
      url,
      status: typeof response?.status === "number" ? response.status : undefined,
      mimeType: typeof response?.mimeType === "string" ? response.mimeType : undefined,
      resourceType: type,
    };
    this.responses.set(requestId, payload);
    const result = await this.emit({ name: "network:response", context: this.context(this.currentUrl()), payload });
    if (result.needsResponseBody) {
      this.responseBodyRequests.add(requestId);
    }
  }

  private async handleNetworkLoadingFinished(params: Record<string, unknown>) {
    const requestId = typeof params.requestId === "string" ? params.requestId : undefined;
    if (!requestId) {
      return;
    }

    const response = this.responses.get(requestId);
    this.requests.delete(requestId);
    this.responses.delete(requestId);
    const shouldLoadBody = this.responseBodyRequests.delete(requestId);
    if (!response || !this.isUsable()) {
      return;
    }
    this.trackRecentResponse(response);

    if (!shouldLoadBody || !this.isUsable()) {
      return;
    }

    await this.emitResponseBody(response);
  }

  private async emitPageHtml() {
    if (!this.isUsable()) {
      return;
    }

    const pageUrl = this.currentUrl();
    const html = await this.options.view.webContents.executeJavaScript(
      "document.documentElement ? document.documentElement.outerHTML : ''",
      true,
    ).catch(() => "");
    if (!html || !this.isUsable()) {
      return;
    }

    const result = await this.emit<PageHtmlPayload>({
      name: "page:html",
      context: this.context(pageUrl),
      payload: { pageUrl, html },
    });
    if (result.replayRecentNetworkResponses) {
      await this.emitNeededRecentResponseBodies(pageUrl);
    }
    if (result.responseBodyRequests?.length) {
      await this.emitRequestedResponseBodies(result.responseBodyRequests);
    }
  }

  private async emitNeededRecentResponseBodies(pageUrl: string) {
    for (const response of this.recentResponses.values()) {
      if (!this.isUsable()) {
        return;
      }

      const result = await this.emit({
        name: "network:response",
        context: this.context(pageUrl),
        payload: response,
      });
      if (result.needsResponseBody) {
        await this.emitResponseBody(response);
      }
    }
  }

  private async emitResponseBody(response: NetworkResponsePayload) {
    if (this.emittedResponseBodies.has(response.requestId) || !this.isUsable()) {
      return;
    }

    const body = await this.options.view.webContents.debugger.sendCommand("Network.getResponseBody", {
      requestId: response.requestId,
    }).catch(() => undefined) as {
      body?: string;
      base64Encoded?: boolean;
    } | undefined;
    if (!body?.body || !this.isUsable()) {
      return;
    }

    const bytes = body.base64Encoded ? Buffer.from(body.body, "base64") : Buffer.from(body.body);
    const payload: NetworkResponseBodyPayload = {
      ...response,
      bytes,
      base64Encoded: Boolean(body.base64Encoded),
    };
    this.emittedResponseBodies.add(response.requestId);
    await this.emit({ name: "network:responseBody", context: this.context(this.currentUrl()), payload });
  }

  private async emitRequestedResponseBodies(responses: NetworkResponsePayload[]) {
    for (const response of responses) {
      if (!this.isUsable() || this.emittedResponseBodies.has(response.requestId)) {
        continue;
      }

      const bytes = await this.loadNetworkResource(response.url);
      if (!bytes?.length || !this.isUsable()) {
        continue;
      }

      const payload: NetworkResponseBodyPayload = {
        ...response,
        bytes,
        base64Encoded: true,
      };
      this.emittedResponseBodies.add(response.requestId);
      await this.emit({ name: "network:responseBody", context: this.context(this.currentUrl()), payload });
    }
  }

  private async loadNetworkResource(url: string) {
    const frameId = await this.mainFrameId();
    if (!frameId) {
      return undefined;
    }

    const result = await this.options.view.webContents.debugger.sendCommand("Network.loadNetworkResource", {
      frameId,
      url,
      options: {
        disableCache: false,
        includeCredentials: true,
      },
    }).catch(() => undefined) as {
      resource?: {
        success?: boolean;
        stream?: string;
      };
    } | undefined;
    const stream = result?.resource?.success ? result.resource.stream : undefined;
    if (!stream) {
      return undefined;
    }

    try {
      const chunks: Buffer[] = [];
      while (this.isUsable()) {
        const chunk = await this.options.view.webContents.debugger.sendCommand("IO.read", { handle: stream }).catch(() => undefined) as {
          data?: string;
          eof?: boolean;
          base64Encoded?: boolean;
        } | undefined;
        if (!chunk) {
          return undefined;
        }

        if (chunk.data) {
          chunks.push(Buffer.from(chunk.data, chunk.base64Encoded ? "base64" : "utf8"));
        }
        if (chunk.eof) {
          break;
        }
      }

      return Buffer.concat(chunks);
    } finally {
      await this.options.view.webContents.debugger.sendCommand("IO.close", { handle: stream }).catch(() => undefined);
    }
  }

  private async mainFrameId() {
    const frameTree = await this.options.view.webContents.debugger.sendCommand("Page.getFrameTree").catch(() => undefined) as {
      frameTree?: {
        frame?: {
          id?: string;
        };
      };
    } | undefined;
    return frameTree?.frameTree?.frame?.id;
  }

  private trackRecentResponse(response: NetworkResponsePayload) {
    this.recentResponses.set(response.url, response);
    while (this.recentResponses.size > 600) {
      const firstKey = this.recentResponses.keys().next().value as string | undefined;
      if (!firstKey) {
        break;
      }
      this.recentResponses.delete(firstKey);
    }
    while (this.emittedResponseBodies.size > 1000) {
      const firstKey = this.emittedResponseBodies.keys().next().value as string | undefined;
      if (!firstKey) {
        break;
      }
      this.emittedResponseBodies.delete(firstKey);
    }
  }

  private async mountContentScripts() {
    if (!this.isUsable() || !this.options.getContentScripts) {
      return;
    }

    const scripts = await Promise.resolve(this.options.getContentScripts()).catch((error: unknown) => {
      console.error(`[jarvis-monitor] ${this.options.context.viewKey} 内容脚本加载失败`, error);
      return [] as JarvisContentScriptAsset[];
    });
    if (!this.isUsable() || scripts.length === 0) {
      return;
    }

    const webContents = this.options.view.webContents;
    for (const script of scripts) {
      if (!this.isUsable()) {
        return;
      }

      const code = createContentScriptCode(script);
      if (!code) {
        continue;
      }

      await webContents.executeJavaScript(code, true).catch((error: unknown) => {
        console.error(`[jarvis-monitor] ${this.options.context.viewKey} 内容脚本 ${script.id} 挂载失败`, error);
      });
    }
  }

  private async emit<TPayload>(event: JarvisMonitorEvent<TPayload>) {
    if (!this.isUsable()) {
      return {};
    }

    const result = await Promise.resolve(this.options.handleEvent(event)).catch((error: unknown) => {
      console.error(`[jarvis-monitor] ${event.context.viewKey} ${event.name} 处理失败`, error);
      return undefined;
    });
    return result ?? {};
  }

  private context(pageUrl: string): JarvisMonitorContext {
    return {
      ...this.options.context,
      pageUrl,
    };
  }

  private currentUrl() {
    const webContents = this.options.view.webContents;
    return webContents.isDestroyed() ? "" : webContents.getURL();
  }

  private isUsable() {
    return !this.disposed && this.options.isAlive() && !this.options.view.webContents.isDestroyed();
  }
}

function createContentScriptCode(script: JarvisContentScriptAsset) {
  const chunks: string[] = [];
  if (script.css) {
    chunks.push(`
      (() => {
        const style = document.createElement('style');
        style.dataset.jarvisScript = ${JSON.stringify(script.id)};
        style.textContent = ${JSON.stringify(script.css)};
        document.documentElement.appendChild(style);
      })();
    `);
  }

  if (script.js) {
    chunks.push(`
      (() => {
        const send = (channel, data) => console.info('[jarvis-monitor]' + JSON.stringify({ scriptId: ${JSON.stringify(script.id)}, channel, data }));
        const jarvis = Object.freeze({ send });
        ${script.js}
      })();
    `);
  }

  return chunks.join("\n");
}

function parseMonitorConsoleMessage(message: string) {
  if (!message.startsWith("[jarvis-monitor]")) {
    return undefined;
  }

  try {
    return JSON.parse(message.slice("[jarvis-monitor]".length).trim()) as { channel?: unknown; data?: unknown };
  } catch {
    return undefined;
  }
}
