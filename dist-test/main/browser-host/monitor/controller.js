"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.JarvisMonitorController = void 0;
class JarvisMonitorController {
    options;
    requests = new Map();
    responses = new Map();
    recentResponses = new Map();
    responseBodyRequests = new Set();
    emittedResponseBodies = new Set();
    disposed = false;
    attachedDebugger = false;
    debuggerListener;
    constructor(options) {
        this.options = options;
    }
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
    handleDidFinishLoad = () => {
        void this.emitPageHtml();
        void this.mountContentScripts();
    };
    handleDomReady = () => {
        void this.emitPageHtml();
        void this.mountContentScripts();
    };
    handlePageTitleUpdated = (_event, title) => {
        void this.emit({
            name: "page:title",
            context: this.context(this.currentUrl()),
            payload: { title },
        });
    };
    handleConsoleMessage = (_event, _level, message) => {
        if (!message.startsWith("[jarvis-monitor]")) {
            return;
        }
        const monitorMessage = parseMonitorConsoleMessage(message);
        const payload = {
            channel: typeof monitorMessage?.channel === "string" ? monitorMessage.channel : "console",
            data: monitorMessage?.data ?? message.slice("[jarvis-monitor]".length).trim(),
        };
        void this.emit({
            name: "dom:message",
            context: this.context(this.currentUrl()),
            payload,
        });
    };
    async handleNetworkRequest(params) {
        const requestId = typeof params.requestId === "string" ? params.requestId : undefined;
        const request = params.request;
        const type = typeof params.type === "string" ? params.type : undefined;
        const url = typeof request?.url === "string" ? request.url : undefined;
        if (!requestId || !url) {
            return;
        }
        const payload = {
            requestId,
            url,
            method: typeof request?.method === "string" ? request.method : undefined,
            resourceType: type,
        };
        this.requests.set(requestId, payload);
        await this.emit({ name: "network:request", context: this.context(this.currentUrl()), payload });
    }
    async handleNetworkResponse(params) {
        const requestId = typeof params.requestId === "string" ? params.requestId : undefined;
        const response = params.response;
        const type = typeof params.type === "string" ? params.type : undefined;
        const url = typeof response?.url === "string" ? response.url : undefined;
        if (!requestId || !url) {
            return;
        }
        const payload = {
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
    async handleNetworkLoadingFinished(params) {
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
    async emitPageHtml() {
        if (!this.isUsable()) {
            return;
        }
        const pageUrl = this.currentUrl();
        const html = await this.options.view.webContents.executeJavaScript("document.documentElement ? document.documentElement.outerHTML : ''", true).catch(() => "");
        if (!html || !this.isUsable()) {
            return;
        }
        const result = await this.emit({
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
    async emitNeededRecentResponseBodies(pageUrl) {
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
    async emitResponseBody(response) {
        if (this.emittedResponseBodies.has(response.requestId) || !this.isUsable()) {
            return;
        }
        const body = await this.options.view.webContents.debugger.sendCommand("Network.getResponseBody", {
            requestId: response.requestId,
        }).catch(() => undefined);
        if (!body?.body || !this.isUsable()) {
            return;
        }
        const bytes = body.base64Encoded ? Buffer.from(body.body, "base64") : Buffer.from(body.body);
        const payload = {
            ...response,
            bytes,
            base64Encoded: Boolean(body.base64Encoded),
        };
        this.emittedResponseBodies.add(response.requestId);
        await this.emit({ name: "network:responseBody", context: this.context(this.currentUrl()), payload });
    }
    async emitRequestedResponseBodies(responses) {
        for (const response of responses) {
            if (!this.isUsable() || this.emittedResponseBodies.has(response.requestId)) {
                continue;
            }
            const bytes = await this.loadNetworkResource(response.url);
            if (!bytes?.length || !this.isUsable()) {
                continue;
            }
            const payload = {
                ...response,
                bytes,
                base64Encoded: true,
            };
            this.emittedResponseBodies.add(response.requestId);
            await this.emit({ name: "network:responseBody", context: this.context(this.currentUrl()), payload });
        }
    }
    async loadNetworkResource(url) {
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
        }).catch(() => undefined);
        const stream = result?.resource?.success ? result.resource.stream : undefined;
        if (!stream) {
            return undefined;
        }
        try {
            const chunks = [];
            while (this.isUsable()) {
                const chunk = await this.options.view.webContents.debugger.sendCommand("IO.read", { handle: stream }).catch(() => undefined);
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
        }
        finally {
            await this.options.view.webContents.debugger.sendCommand("IO.close", { handle: stream }).catch(() => undefined);
        }
    }
    async mainFrameId() {
        const frameTree = await this.options.view.webContents.debugger.sendCommand("Page.getFrameTree").catch(() => undefined);
        return frameTree?.frameTree?.frame?.id;
    }
    trackRecentResponse(response) {
        this.recentResponses.set(response.url, response);
        while (this.recentResponses.size > 600) {
            const firstKey = this.recentResponses.keys().next().value;
            if (!firstKey) {
                break;
            }
            this.recentResponses.delete(firstKey);
        }
        while (this.emittedResponseBodies.size > 1000) {
            const firstKey = this.emittedResponseBodies.keys().next().value;
            if (!firstKey) {
                break;
            }
            this.emittedResponseBodies.delete(firstKey);
        }
    }
    async mountContentScripts() {
        if (!this.isUsable() || !this.options.getContentScripts) {
            return;
        }
        const scripts = await Promise.resolve(this.options.getContentScripts()).catch((error) => {
            console.error(`[jarvis-monitor] ${this.options.context.viewKey} 内容脚本加载失败`, error);
            return [];
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
            await webContents.executeJavaScript(code, true).catch((error) => {
                console.error(`[jarvis-monitor] ${this.options.context.viewKey} 内容脚本 ${script.id} 挂载失败`, error);
            });
        }
    }
    async emit(event) {
        if (!this.isUsable()) {
            return {};
        }
        const result = await Promise.resolve(this.options.handleEvent(event)).catch((error) => {
            console.error(`[jarvis-monitor] ${event.context.viewKey} ${event.name} 处理失败`, error);
            return undefined;
        });
        return result ?? {};
    }
    context(pageUrl) {
        return {
            ...this.options.context,
            pageUrl,
        };
    }
    currentUrl() {
        const webContents = this.options.view.webContents;
        return webContents.isDestroyed() ? "" : webContents.getURL();
    }
    isUsable() {
        return !this.disposed && this.options.isAlive() && !this.options.view.webContents.isDestroyed();
    }
}
exports.JarvisMonitorController = JarvisMonitorController;
function createContentScriptCode(script) {
    const chunks = [];
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
function parseMonitorConsoleMessage(message) {
    if (!message.startsWith("[jarvis-monitor]")) {
        return undefined;
    }
    try {
        return JSON.parse(message.slice("[jarvis-monitor]".length).trim());
    }
    catch {
        return undefined;
    }
}
