import { Worker } from "node:worker_threads";
import { join, resolve } from "node:path";
import { readFile } from "node:fs/promises";
import type { BrowserWindow } from "electron";
import type { JarvisScript, JarvisScriptRuntimeState } from "../../shared/types";
import { dataPaths } from "../data-paths";
import type { MetadataStore } from "../store";
import type {
  JarvisContentScriptAsset,
  JarvisMonitorEvent,
  JarvisMonitorHandleResult,
  JarvisMonitorScript,
  NetworkResponsePayload,
} from "../browser-host/monitor/types";
import { BuiltinFaviconScript } from "./scripts/favicon-script";
import { BuiltinTitleScript } from "./scripts/title-script";

interface RuntimeOptions {
  window: BrowserWindow;
  store: MetadataStore;
  emitMetadataUpdate: () => void;
  emitBrowserState: (viewKey?: string, errorText?: string) => void;
  isPageSuccessful: (viewKey: string, pageUrl: string) => boolean;
  resolveRequestContext: (input: { siteId?: string; sessionId?: string }) => JarvisScriptRequestContext;
  sendMessageToWebContents: (input: {
    siteId?: string;
    sessionId?: string;
    channel: string;
    payload: unknown;
  }) => Promise<void>;
}

interface JarvisScriptRequestContext {
  session: Electron.Session;
  userAgent?: string;
}

export class JarvisScriptRuntime {
  private readonly builtins: JarvisMonitorScript[];
  private readonly runtimeStates = new Map<string, JarvisScriptRuntimeState>();
  private readonly workers = new Map<string, Worker>();
  private readonly workerScripts = new Map<string, JarvisScript>();

  constructor(private readonly options: RuntimeOptions) {
    this.builtins = [
      new BuiltinTitleScript({
        store: options.store,
        emitMetadataUpdate: options.emitMetadataUpdate,
        emitBrowserState: options.emitBrowserState,
      }),
      new BuiltinFaviconScript({
        store: options.store,
        emitMetadataUpdate: options.emitMetadataUpdate,
        isPageSuccessful: options.isPageSuccessful,
      }),
    ];
  }

  async handleMonitorEvent(event: JarvisMonitorEvent) {
    const result: JarvisMonitorHandleResult = {};
    const scripts = this.getEnabledMonitorScripts(event.context.siteId);
    for (const script of scripts) {
      if (event.name === "network:response" && script.needsResponseBody?.(event as JarvisMonitorEvent<NetworkResponsePayload>)) {
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

  private collectResponseBodyRequests(scripts: JarvisMonitorScript[], event: JarvisMonitorEvent) {
    const responses = new Map<string, NetworkResponsePayload>();
    for (const script of scripts) {
      for (const response of script.getResponseBodyRequests?.(event) ?? []) {
        responses.set(response.url, response);
      }
    }

    return [...responses.values()];
  }

  async getContentScripts(siteId: string | undefined, pageUrl: string) {
    const scripts = [
      ...this.options.store.listGlobalJarvisScripts(),
      ...(siteId ? this.options.store.listSiteJarvisScripts(siteId) : []),
    ].filter((script) => script.runtimeState.enabled);
    const assets: JarvisContentScriptAsset[] = [];

    for (const script of scripts) {
      for (const declaration of script.manifest.contentScripts ?? []) {
        if (!matchesAnyUrl(declaration.matches, { context: { pageUrl } } as JarvisMonitorEvent)) {
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

  listSiteRuntimeStates(siteId: string) {
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

  stopScript(script: JarvisScript) {
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

  private getEnabledMonitorScripts(siteId?: string) {
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

  private attachRuntimeStates(scripts: JarvisScript[]) {
    return scripts.map((script) => ({
      ...script,
      runtimeState: this.runtimeStates.get(this.scriptKey(script)) ?? script.runtimeState,
    }));
  }

  private startWorker(script: JarvisScript, workerId: string, entryPath: string) {
    let entry: string;
    try {
      entry = this.resolveScriptSourcePath(script, entryPath);
    } catch (error) {
      this.markScriptError(script, error);
      return;
    }

    const key = this.workerKey(script, workerId);
    const worker = new Worker(join(__dirname, "worker-host.js"), {
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
    worker.on("message", (message: WorkerMessage) => {
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

  private postEventToWorker(script: JarvisScript, event: JarvisMonitorEvent) {
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

  private readonly markScriptError = (script: JarvisScript, error: unknown) => {
    const runtimeState = {
      enabled: script.runtimeState.enabled,
      loadError: error instanceof Error ? error.message : String(error),
      lastStoppedAt: new Date().toISOString(),
    };
    this.runtimeStates.set(this.scriptKey(script), runtimeState);

    void this.persistRuntimeState(script, runtimeState);
  };

  private async markScriptStarted(script: JarvisScript) {
    const runtimeState = {
      enabled: true,
      loadError: undefined,
      lastStartedAt: new Date().toISOString(),
    };
    this.runtimeStates.set(this.scriptKey(script), runtimeState);
    await this.persistRuntimeState(script, runtimeState);
  }

  private async persistRuntimeState(script: JarvisScript, runtimeState: Partial<JarvisScriptRuntimeState>) {
    if (script.scope === "site" && script.siteId) {
      await this.options.store.updateSiteJarvisScript(script.siteId, script.id, { runtimeState });
      this.emitJarvisScriptUpdate(script.siteId, this.attachRuntimeStates(this.options.store.listSiteJarvisScripts(script.siteId)));
      return;
    }

    await this.options.store.updateGlobalJarvisScript(script.id, { runtimeState });
    this.emitJarvisScriptUpdate(undefined, this.attachRuntimeStates(this.options.store.listGlobalJarvisScripts()));
  }

  private emitJarvisScriptUpdate(siteId: string | undefined, scripts: JarvisScript[]) {
    if (!this.options.window.isDestroyed() && !this.options.window.webContents.isDestroyed()) {
      this.options.window.webContents.send("jarvis-script:updated", siteId, scripts);
    }
  }

  private scriptKey(script: Pick<JarvisScript, "scope" | "siteId" | "id">) {
    return `${script.scope}:${script.siteId ?? "global"}:${script.id}`;
  }

  private workerKey(script: Pick<JarvisScript, "scope" | "siteId" | "id">, workerId: string) {
    return `${this.scriptKey(script)}:${workerId}`;
  }

  private workerKeys(script: JarvisScript) {
    return (script.manifest.workers ?? []).map((worker) => this.workerKey(script, worker.id));
  }

  private getScriptDataDir(script: JarvisScript) {
    if (script.scope === "site" && script.siteId) {
      return dataPaths.sites.jarvisScriptDataDir(script.siteId, script.id);
    }

    return dataPaths.global.jarvisScriptDataDir(script.id);
  }

  private async handleRpc(script: JarvisScript, message: WorkerRpcMessage) {
    const worker = this.workers.get(this.workerKey(script, message.workerId));
    if (!worker) {
      return;
    }

    try {
      const value = await this.runRpc(script, message);
      worker.postMessage({ type: "jarvis-script:rpc-result", rpcId: message.rpcId, value });
    } catch (error) {
      worker.postMessage({
        type: "jarvis-script:rpc-result",
        rpcId: message.rpcId,
        error: error instanceof Error ? error.message : String(error),
      });
      this.markScriptError(script, error);
    }
  }

  private async runRpc(script: JarvisScript, message: WorkerRpcMessage) {
    if (message.method === "http:request") {
      this.assertPermission(script, "http");
      return this.handleHttpRequest(script, message.payload);
    }

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

  private async handleHttpRequest(script: JarvisScript, payload?: Record<string, unknown>) {
    const input = typeof payload?.input === "string" ? payload.input : undefined;
    if (!input) {
      throw new Error("Jarvis Script HTTP 请求缺少 URL");
    }

    const requestUrl = new URL(input).toString();
    const requestInit = parseRequestInit(payload?.init);
    const context = this.options.resolveRequestContext({
      siteId: typeof payload?.siteId === "string" ? payload.siteId : script.siteId,
      sessionId: typeof payload?.sessionId === "string" ? payload.sessionId : undefined,
    });
    const headers = new Headers(requestInit.headers);
    if (context.userAgent && !headers.has("user-agent")) {
      headers.set("user-agent", context.userAgent);
    }

    if (!headers.has("cookie")) {
      const cookies = await context.session.cookies.get({ url: requestUrl });
      const cookieHeader = cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
      if (cookieHeader) {
        headers.set("cookie", cookieHeader);
      }
    }

    const response = await context.session.fetch(requestUrl, {
      ...requestInit,
      headers,
    });
    const contentType = response.headers.get("content-type") ?? "";
    if (contentType.includes("application/json")) {
      return response.json();
    }

    return response.text();
  }

  private assertPermission(script: JarvisScript, permission: string) {
    if ((script.manifest.permissions ?? []).includes(permission)) {
      return;
    }

    throw new Error(`${script.name} 缺少权限：${permission}`);
  }

  private resolveTargetSiteId(script: JarvisScript, payload?: Record<string, unknown>) {
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

  private async readContentFiles(script: JarvisScript, files: string[]) {
    const chunks: string[] = [];
    const rootPath = `${resolve(script.path)}/`;
    for (const file of files) {
      const filePath = resolve(script.path, file);
      if (filePath !== resolve(script.path) && !filePath.startsWith(rootPath)) {
        throw new Error("内容脚本路径越界");
      }

      chunks.push(await readFile(filePath, "utf8"));
    }

    return chunks.join("\n");
  }

  private resolveScriptSourcePath(script: JarvisScript, file: string) {
    const filePath = resolve(script.path, file);
    const rootPath = `${resolve(script.path)}/`;
    if (filePath !== resolve(script.path) && !filePath.startsWith(rootPath)) {
      throw new Error("脚本路径越界");
    }

    return filePath;
  }

  private async stopWorker(key: string, worker: Worker) {
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

type WorkerMessage = {
  type?: string;
  error?: string;
  message?: string;
  rpcId?: string;
  workerId?: string;
  method?: string;
  payload?: Record<string, unknown>;
  value?: unknown;
};

type WorkerRpcMessage = WorkerMessage & {
  type: "jarvis-script:rpc";
  rpcId: string;
  workerId: string;
  method: string;
  payload?: Record<string, unknown>;
};

function isWorkerRpcMessage(message: WorkerMessage): message is WorkerRpcMessage {
  return message.type === "jarvis-script:rpc"
    && typeof message.rpcId === "string"
    && typeof message.workerId === "string"
    && typeof message.method === "string";
}

function parseRequestInit(value: unknown): RequestInit {
  if (!value || typeof value !== "object") {
    return {};
  }

  const input = value as {
    method?: unknown;
    headers?: unknown;
    body?: unknown;
  };
  const init: RequestInit = {};
  if (typeof input.method === "string") {
    init.method = input.method;
  }
  if (input.headers && typeof input.headers === "object") {
    init.headers = input.headers as Record<string, string>;
  }
  if (typeof input.body === "string") {
    init.body = input.body;
  }

  return init;
}

class UserJarvisMonitorScript implements JarvisMonitorScript {
  readonly id: string;
  readonly name: string;
  readonly enabled: boolean;

  constructor(
    private readonly script: JarvisScript,
    private readonly markError: (script: JarvisScript, error: unknown) => void,
    private readonly postEvent: (script: JarvisScript, event: JarvisMonitorEvent) => void,
  ) {
    this.id = script.id;
    this.name = script.name;
    this.enabled = script.runtimeState.enabled;
  }

  matches(event: JarvisMonitorEvent) {
    return (this.script.manifest.monitors ?? []).some((monitor) => (
      (monitor.events ?? []).includes(event.name)
      && matchesAnyUrl(monitor.matches, event)
    ));
  }

  needsResponseBody(event: JarvisMonitorEvent<NetworkResponsePayload>) {
    return (this.script.manifest.monitors ?? []).some((monitor) => (
      (monitor.events ?? []).includes("network:responseBody")
      && matchesAnyUrl(monitor.matches, event)
    ));
  }

  async handle(event: JarvisMonitorEvent) {
    try {
      if (this.script.manifest.workers?.length) {
        this.postEvent(this.script, event);
        return;
      }
    } catch (error) {
      this.markError(this.script, error);
    }
  }
}

function serializeMonitorEvent(event: JarvisMonitorEvent) {
  const payload = event.payload as Record<string, unknown>;
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

function matchesAnyUrl(patterns: string[] | undefined, event: JarvisMonitorEvent) {
  if (!patterns || patterns.length === 0) {
    return true;
  }

  return patterns.some((pattern) => matchesUrl(pattern, event));
}

function matchesUrl(pattern: string | undefined, event: JarvisMonitorEvent) {
  if (!pattern) {
    return true;
  }

  const payload = (event.payload ?? {}) as { url?: string; pageUrl?: string };
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
