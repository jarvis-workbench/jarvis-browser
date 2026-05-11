"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.JarvisScriptRuntime = void 0;
const node_worker_threads_1 = require("node:worker_threads");
const node_path_1 = require("node:path");
const promises_1 = require("node:fs/promises");
const data_paths_1 = require("../data-paths");
const favicon_script_1 = require("./scripts/favicon-script");
const title_script_1 = require("./scripts/title-script");
class JarvisScriptRuntime {
    options;
    builtins;
    runtimeStates = new Map();
    workers = new Map();
    workerScripts = new Map();
    constructor(options) {
        this.options = options;
        this.builtins = [
            new title_script_1.BuiltinTitleScript({
                store: options.store,
                emitMetadataUpdate: options.emitMetadataUpdate,
                emitBrowserState: options.emitBrowserState,
            }),
            new favicon_script_1.BuiltinFaviconScript({
                store: options.store,
                emitMetadataUpdate: options.emitMetadataUpdate,
                isPageSuccessful: options.isPageSuccessful,
            }),
        ];
    }
    async handleMonitorEvent(event) {
        const result = {};
        const scripts = this.getEnabledMonitorScripts(event.context.siteId);
        for (const script of scripts) {
            if (event.name === "network:response" && script.needsResponseBody?.(event)) {
                result.needsResponseBody = true;
            }
            if (!script.matches(event)) {
                continue;
            }
            await script.handle(event);
        }
        if (event.name === "page:html") {
            result.replayRecentNetworkResponses = true;
            result.responseBodyRequests = this.collectResponseBodyRequests(scripts, event);
        }
        return result;
    }
    collectResponseBodyRequests(scripts, event) {
        const responses = new Map();
        for (const script of scripts) {
            for (const response of script.getResponseBodyRequests?.(event) ?? []) {
                responses.set(response.url, response);
            }
        }
        return [...responses.values()];
    }
    async getContentScripts(siteId, pageUrl) {
        const scripts = [
            ...this.options.store.listGlobalJarvisScripts(),
            ...(siteId ? this.options.store.listSiteJarvisScripts(siteId) : []),
        ].filter((script) => script.runtimeState.enabled);
        const assets = [];
        for (const script of scripts) {
            for (const declaration of script.manifest.contentScripts ?? []) {
                if (!matchesAnyUrl(declaration.matches, { context: { pageUrl } })) {
                    continue;
                }
                const id = `${this.scriptKey(script)}:${declaration.id}`;
                assets.push({
                    id,
                    js: await this.readContentFiles(script, declaration.js ?? []),
                    css: await this.readContentFiles(script, declaration.css ?? []),
                });
            }
        }
        return assets.filter((asset) => asset.js || asset.css);
    }
    listGlobalRuntimeStates() {
        return this.attachRuntimeStates(this.options.store.listGlobalJarvisScripts());
    }
    listSiteRuntimeStates(siteId) {
        return this.attachRuntimeStates(this.options.store.listSiteJarvisScripts(siteId));
    }
    async refreshUserScriptWorkers() {
        const enabledScripts = [
            ...this.options.store.listGlobalJarvisScripts(),
            ...this.options.store.listSites().flatMap((site) => this.options.store.listSiteJarvisScripts(site.id)),
        ].filter((script) => script.runtimeState.enabled);
        const enabledKeys = new Set(enabledScripts.flatMap((script) => this.workerKeys(script)));
        for (const script of enabledScripts) {
            for (const workerDeclaration of script.manifest.workers ?? []) {
                const key = this.workerKey(script, workerDeclaration.id);
                if (!this.workers.has(key)) {
                    this.startWorker(script, workerDeclaration.id, workerDeclaration.entry);
                }
            }
        }
        for (const [key, worker] of this.workers) {
            if (!enabledKeys.has(key)) {
                await this.stopWorker(key, worker);
            }
        }
    }
    stopScript(script) {
        for (const key of this.workerKeys(script)) {
            const worker = this.workers.get(key);
            if (worker) {
                void this.stopWorker(key, worker);
            }
        }
    }
    close() {
        for (const worker of this.workers.values()) {
            worker.postMessage({ type: "jarvis-script:deactivate" });
            worker.terminate().catch(() => undefined);
        }
        this.workers.clear();
        this.workerScripts.clear();
    }
    getEnabledMonitorScripts(siteId) {
        const userScripts = [
            ...this.options.store.listGlobalJarvisScripts(),
            ...(siteId ? this.options.store.listSiteJarvisScripts(siteId) : []),
        ]
            .filter((script) => script.runtimeState.enabled)
            .map((script) => new UserJarvisMonitorScript(script, this.markScriptError, (targetScript, event) => {
            this.postEventToWorker(targetScript, event);
        }));
        return [
            ...this.builtins,
            ...userScripts,
        ];
    }
    attachRuntimeStates(scripts) {
        return scripts.map((script) => ({
            ...script,
            runtimeState: this.runtimeStates.get(this.scriptKey(script)) ?? script.runtimeState,
        }));
    }
    startWorker(script, workerId, entryPath) {
        let entry;
        try {
            entry = this.resolveScriptSourcePath(script, entryPath);
        }
        catch (error) {
            this.markScriptError(script, error);
            return;
        }
        const key = this.workerKey(script, workerId);
        const worker = new node_worker_threads_1.Worker((0, node_path_1.join)(__dirname, "worker-host.js"), {
            workerData: {
                script,
                workerId,
                entry,
                dataDir: this.getScriptDataDir(script),
            },
        });
        this.workers.set(key, worker);
        this.workerScripts.set(key, script);
        const startedState = {
            enabled: true,
            lastStartedAt: new Date().toISOString(),
        };
        this.runtimeStates.set(key, startedState);
        this.runtimeStates.set(this.scriptKey(script), startedState);
        worker.on("message", (message) => {
            if (message.type === "jarvis-script:ready") {
                void this.markScriptStarted(script);
            }
            if (message.type === "jarvis-script:error") {
                this.markScriptError(script, message.error ?? "脚本执行失败");
            }
            if (message.type === "jarvis-script:log" && message.message) {
                console.info(`[jarvis-script] ${script.name}: ${message.message}`);
            }
            if (message.type === "jarvis-script:rpc") {
                if (isWorkerRpcMessage(message)) {
                    void this.handleRpc(script, message);
                }
            }
        });
        worker.on("error", (error) => this.markScriptError(script, error));
        worker.on("messageerror", (error) => this.markScriptError(script, error));
        worker.on("exit", (code) => {
            if (code !== 0) {
                const stoppedState = {
                    enabled: true,
                    loadError: `Worker 退出码：${code}`,
                    lastStoppedAt: new Date().toISOString(),
                };
                this.runtimeStates.set(key, stoppedState);
                this.runtimeStates.set(this.scriptKey(script), stoppedState);
            }
            this.workers.delete(key);
            this.workerScripts.delete(key);
        });
    }
    postEventToWorker(script, event) {
        for (const workerId of (script.manifest.workers ?? []).map((worker) => worker.id)) {
            const worker = this.workers.get(this.workerKey(script, workerId));
            if (!worker) {
                continue;
            }
            worker.postMessage({
                type: "jarvis-monitor:event",
                event: serializeMonitorEvent(event),
            });
        }
    }
    markScriptError = (script, error) => {
        const runtimeState = {
            enabled: script.runtimeState.enabled,
            loadError: error instanceof Error ? error.message : String(error),
            lastStoppedAt: new Date().toISOString(),
        };
        this.runtimeStates.set(this.scriptKey(script), runtimeState);
        void this.persistRuntimeState(script, runtimeState);
    };
    async markScriptStarted(script) {
        const runtimeState = {
            enabled: true,
            loadError: undefined,
            lastStartedAt: new Date().toISOString(),
        };
        this.runtimeStates.set(this.scriptKey(script), runtimeState);
        await this.persistRuntimeState(script, runtimeState);
    }
    async persistRuntimeState(script, runtimeState) {
        if (script.scope === "site" && script.siteId) {
            await this.options.store.updateSiteJarvisScript(script.siteId, script.id, { runtimeState });
            this.emitJarvisScriptUpdate(script.siteId, this.attachRuntimeStates(this.options.store.listSiteJarvisScripts(script.siteId)));
            return;
        }
        await this.options.store.updateGlobalJarvisScript(script.id, { runtimeState });
        this.emitJarvisScriptUpdate(undefined, this.attachRuntimeStates(this.options.store.listGlobalJarvisScripts()));
    }
    emitJarvisScriptUpdate(siteId, scripts) {
        if (!this.options.window.isDestroyed() && !this.options.window.webContents.isDestroyed()) {
            this.options.window.webContents.send("jarvis-script:updated", siteId, scripts);
        }
    }
    scriptKey(script) {
        return `${script.scope}:${script.siteId ?? "global"}:${script.id}`;
    }
    workerKey(script, workerId) {
        return `${this.scriptKey(script)}:${workerId}`;
    }
    workerKeys(script) {
        return (script.manifest.workers ?? []).map((worker) => this.workerKey(script, worker.id));
    }
    getScriptDataDir(script) {
        if (script.scope === "site" && script.siteId) {
            return data_paths_1.dataPaths.sites.jarvisScriptDataDir(script.siteId, script.id);
        }
        return data_paths_1.dataPaths.global.jarvisScriptDataDir(script.id);
    }
    async handleRpc(script, message) {
        const worker = this.workers.get(this.workerKey(script, message.workerId));
        if (!worker) {
            return;
        }
        try {
            const value = await this.runRpc(script, message);
            worker.postMessage({ type: "jarvis-script:rpc-result", rpcId: message.rpcId, value });
        }
        catch (error) {
            worker.postMessage({
                type: "jarvis-script:rpc-result",
                rpcId: message.rpcId,
                error: error instanceof Error ? error.message : String(error),
            });
            this.markScriptError(script, error);
        }
    }
    async runRpc(script, message) {
        if (message.method === "site:update-title") {
            this.assertPermission(script, "site:title");
            const siteId = this.resolveTargetSiteId(script, message.payload);
            return this.options.store.updateSite(siteId, { title: String(message.payload?.title ?? "") });
        }
        if (message.method === "site:update-favicon") {
            this.assertPermission(script, "site:favicon");
            const siteId = this.resolveTargetSiteId(script, message.payload);
            const site = await this.options.store.updateSiteMetadata(siteId, {
                faviconUrl: typeof message.payload?.faviconUrl === "string" ? message.payload.faviconUrl : undefined,
                faviconPath: typeof message.payload?.faviconPath === "string" ? message.payload.faviconPath : undefined,
            });
            this.options.emitMetadataUpdate();
            return site;
        }
        if (message.method === "renderer:message") {
            this.assertPermission(script, "renderer:message");
            if (!this.options.window.isDestroyed() && !this.options.window.webContents.isDestroyed()) {
                this.options.window.webContents.send("jarvis-script:message", {
                    scriptId: script.id,
                    scope: script.scope,
                    siteId: script.siteId,
                    channel: String(message.payload?.channel ?? ""),
                    payload: message.payload?.payload,
                });
            }
            return undefined;
        }
        if (message.method === "browser-tab:message") {
            this.assertPermission(script, "browser-tab:message");
            await this.options.sendMessageToWebContents({
                siteId: typeof message.payload?.siteId === "string" ? message.payload.siteId : script.siteId,
                sessionId: typeof message.payload?.sessionId === "string" ? message.payload.sessionId : undefined,
                channel: String(message.payload?.channel ?? ""),
                payload: message.payload?.payload,
            });
            return undefined;
        }
        throw new Error(`不支持的 Jarvis Script RPC：${message.method}`);
    }
    assertPermission(script, permission) {
        if ((script.manifest.permissions ?? []).includes(permission)) {
            return;
        }
        throw new Error(`${script.name} 缺少权限：${permission}`);
    }
    resolveTargetSiteId(script, payload) {
        if (script.scope === "site" && script.siteId) {
            return script.siteId;
        }
        this.assertPermission(script, "site:write:any");
        const siteId = typeof payload?.siteId === "string" ? payload.siteId : undefined;
        if (!siteId || !this.options.store.getSite(siteId)) {
            throw new Error("目标站点不存在");
        }
        return siteId;
    }
    async readContentFiles(script, files) {
        const chunks = [];
        const rootPath = `${(0, node_path_1.resolve)(script.path)}/`;
        for (const file of files) {
            const filePath = (0, node_path_1.resolve)(script.path, file);
            if (filePath !== (0, node_path_1.resolve)(script.path) && !filePath.startsWith(rootPath)) {
                throw new Error("内容脚本路径越界");
            }
            chunks.push(await (0, promises_1.readFile)(filePath, "utf8"));
        }
        return chunks.join("\n");
    }
    resolveScriptSourcePath(script, file) {
        const filePath = (0, node_path_1.resolve)(script.path, file);
        const rootPath = `${(0, node_path_1.resolve)(script.path)}/`;
        if (filePath !== (0, node_path_1.resolve)(script.path) && !filePath.startsWith(rootPath)) {
            throw new Error("脚本路径越界");
        }
        return filePath;
    }
    async stopWorker(key, worker) {
        const script = this.workerScripts.get(key);
        worker.postMessage({ type: "jarvis-script:deactivate" });
        await Promise.race([
            new Promise((resolveDone) => worker.once("exit", resolveDone)),
            new Promise((resolveDone) => setTimeout(resolveDone, 500)),
        ]).catch(() => undefined);
        await worker.terminate().catch(() => undefined);
        this.workers.delete(key);
        this.workerScripts.delete(key);
        if (script) {
            this.runtimeStates.set(this.scriptKey(script), {
                enabled: false,
                lastStoppedAt: new Date().toISOString(),
            });
        }
    }
}
exports.JarvisScriptRuntime = JarvisScriptRuntime;
function isWorkerRpcMessage(message) {
    return message.type === "jarvis-script:rpc"
        && typeof message.rpcId === "string"
        && typeof message.workerId === "string"
        && typeof message.method === "string";
}
class UserJarvisMonitorScript {
    script;
    markError;
    postEvent;
    id;
    name;
    enabled;
    constructor(script, markError, postEvent) {
        this.script = script;
        this.markError = markError;
        this.postEvent = postEvent;
        this.id = script.id;
        this.name = script.name;
        this.enabled = script.runtimeState.enabled;
    }
    matches(event) {
        return (this.script.manifest.monitors ?? []).some((monitor) => ((monitor.events ?? []).includes(event.name)
            && matchesAnyUrl(monitor.matches, event)));
    }
    needsResponseBody(event) {
        return (this.script.manifest.monitors ?? []).some((monitor) => ((monitor.events ?? []).includes("network:responseBody")
            && matchesAnyUrl(monitor.matches, event)));
    }
    async handle(event) {
        try {
            if (this.script.manifest.workers?.length) {
                this.postEvent(this.script, event);
                return;
            }
        }
        catch (error) {
            this.markError(this.script, error);
        }
    }
}
function serializeMonitorEvent(event) {
    const payload = event.payload;
    return {
        ...event,
        payload: Buffer.isBuffer(payload.bytes)
            ? {
                ...payload,
                bytes: payload.bytes.toString("base64"),
                base64Encoded: true,
            }
            : payload,
    };
}
function matchesAnyUrl(patterns, event) {
    if (!patterns || patterns.length === 0) {
        return true;
    }
    return patterns.some((pattern) => matchesUrl(pattern, event));
}
function matchesUrl(pattern, event) {
    if (!pattern) {
        return true;
    }
    const payload = (event.payload ?? {});
    const url = payload.url || payload.pageUrl || event.context.pageUrl;
    if (pattern === "*") {
        return true;
    }
    if (pattern.includes("*")) {
        const source = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
        return new RegExp(`^${source}$`).test(url);
    }
    return url.includes(pattern);
}
