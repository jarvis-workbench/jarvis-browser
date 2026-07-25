import { parentPort, workerData } from "node:worker_threads";
import { webcrypto } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { Script, createContext } from "node:vm";
import type { JarvisScript } from "../../shared/types";
import { createId, formatError } from "../../shared/utils";

type ScriptModule = {
  activate?: (api: JarvisScriptWorkerApi) => Promise<void> | void;
  onMonitorEvent?: (event: unknown, api: JarvisScriptWorkerApi) => Promise<void> | void;
  deactivate?: (api: JarvisScriptWorkerApi) => Promise<void> | void;
};

interface WorkerData {
  script: JarvisScript;
  workerId: string;
  entry: string;
  dataDir: string;
}

export interface JarvisScriptWorkerApi {
  script: JarvisScript;
  readText(relativePath: string): Promise<string>;
  writeText(relativePath: string, value: string): Promise<void>;
  /** Absolute filesystem path write via Electron main (requires permission `fs`). */
  writeFile(path: string, value: string): Promise<{ path: string }>;
  /** Absolute filesystem path read via Electron main (requires permission `fs`). */
  readFile(path: string): Promise<string>;
  /** Append text to absolute path via Electron main (requires permission `fs`). */
  appendFile(path: string, value: string): Promise<{ path: string }>;
  /** Native directory picker via Electron dialog (requires permission `dialog`). */
  chooseDirectory(options?: {
    title?: string;
    defaultPath?: string;
    buttonLabel?: string;
  }): Promise<{ canceled: boolean; path?: string }>;
  /** Read cookies from the current Electron session (requires permission `session`). */
  getCookies(filter?: {
    url?: string;
    domain?: string;
    name?: string;
    siteId?: string;
    sessionId?: string;
  }): Promise<Array<{ name: string; value: string; domain?: string; path?: string; httpOnly?: boolean; secure?: boolean }>>;
  log(message: string): void;
  request(input: string | URL, init?: RequestInit): Promise<unknown>;
  openWebSocket(url: string): WebSocket;
  updateSiteTitle(title: string): Promise<void>;
  updateSiteFavicon(input: { faviconUrl?: string; faviconPath?: string }): Promise<void>;
  sendMessage(channel: string, payload: unknown): void;
  sendBrowserTabMessage(input: { channel: string; payload: unknown; siteId?: string; sessionId?: string }): void;
}

const data = workerData as WorkerData;
const api: JarvisScriptWorkerApi = {
  script: data.script,
  readText: async (relativePath) => readFile(resolveDataPath(relativePath), "utf8"),
  writeText: async (relativePath, value) => {
    const filePath = resolveDataPath(relativePath);
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, value, "utf8");
  },
  writeFile: async (targetPath, value) => {
    assertPermission("fs");
    return rpc("fs:write-text", {
      path: String(targetPath || ""),
      value: String(value ?? ""),
    }) as Promise<{ path: string }>;
  },
  readFile: async (targetPath) => {
    assertPermission("fs");
    return rpc("fs:read-text", {
      path: String(targetPath || ""),
    }) as Promise<string>;
  },
  appendFile: async (targetPath, value) => {
    assertPermission("fs");
    return rpc("fs:append-text", {
      path: String(targetPath || ""),
      value: String(value ?? ""),
    }) as Promise<{ path: string }>;
  },
  chooseDirectory: async (options) => {
    assertPermission("dialog");
    return rpc("dialog:choose-directory", {
      title: options?.title,
      defaultPath: options?.defaultPath,
      buttonLabel: options?.buttonLabel,
    }) as Promise<{ canceled: boolean; path?: string }>;
  },
  getCookies: async (filter) => {
    assertPermission("session");
    return rpc("session:get-cookies", {
      url: filter?.url,
      domain: filter?.domain,
      name: filter?.name,
      siteId: filter?.siteId,
      sessionId: filter?.sessionId,
    }) as Promise<Array<{ name: string; value: string; domain?: string; path?: string; httpOnly?: boolean; secure?: boolean }>>;
  },
  log: (message) => parentPort?.postMessage({ type: "jarvis-script:log", message }),
  request: async (input, init) => {
    assertPermission("http");
    return rpc("http:request", {
      input: input.toString(),
      init: serializeRequestInit(init),
    });
  },
  openWebSocket: (url) => {
    assertPermission("ws");
    return new WebSocket(url);
  },
  updateSiteTitle: async (title) => {
    await rpc("site:update-title", { title });
  },
  updateSiteFavicon: async (input) => {
    await rpc("site:update-favicon", input);
  },
  sendMessage: (channel, payload) => {
    void rpc("renderer:message", { channel, payload });
  },
  sendBrowserTabMessage: (input) => {
    void rpc("browser-tab:message", input);
  },
};

let scriptModule: ScriptModule | undefined;
const pendingRpc = new Map<string, {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}>();

void loadScriptModule().then(async (module) => {
  scriptModule = module;
  await scriptModule.activate?.(api);
  parentPort?.postMessage({ type: "jarvis-script:ready" });
}).catch((error: unknown) => {
  parentPort?.postMessage({ type: "jarvis-script:error", error: formatError(error) });
});

parentPort?.on("message", (message: { type?: string; event?: unknown; rpcId?: string; error?: string; value?: unknown }) => {
  if (message.type === "jarvis-monitor:event") {
    void Promise.resolve(scriptModule?.onMonitorEvent?.(message.event, api)).catch((error: unknown) => {
      parentPort?.postMessage({ type: "jarvis-script:error", error: formatError(error) });
    });
  }

  if (message.type === "jarvis-script:rpc-result" && message.rpcId) {
    const pending = pendingRpc.get(message.rpcId);
    if (!pending) {
      return;
    }

    pendingRpc.delete(message.rpcId);
    if (message.error) {
      pending.reject(new Error(message.error));
      return;
    }

    pending.resolve(message.value);
  }

  if (message.type === "jarvis-script:deactivate") {
    void Promise.resolve(scriptModule?.deactivate?.(api)).finally(() => parentPort?.close());
  }
});

function resolveDataPath(relativePath: string) {
  const targetPath = resolve(data.dataDir, relativePath);
  const rootPath = resolve(data.dataDir);
  if (targetPath !== rootPath && !targetPath.startsWith(`${rootPath}/`)) {
    throw new Error("脚本数据路径越界");
  }

  return targetPath;
}

function assertPermission(permission: string) {
  if ((data.script.manifest.permissions ?? []).includes(permission)) {
    return;
  }

  throw new Error(`${data.script.name} 缺少权限：${permission}`);
}

function serializeRequestInit(init?: RequestInit) {
  if (!init) {
    return undefined;
  }

  return {
    method: init.method,
    headers: serializeHeaders(init.headers),
    body: typeof init.body === "string" ? init.body : undefined,
  };
}

function serializeHeaders(headers?: HeadersInit) {
  if (!headers) {
    return undefined;
  }

  return Object.fromEntries(new Headers(headers).entries());
}

async function loadScriptModule() {
  const source = await readFile(data.entry, "utf8");
  const moduleExports: ScriptModule = {};
  const context = createContext({
    exports: moduleExports,
    module: { exports: moduleExports },
    console: {
      log: (...args: unknown[]) => api.log(args.map(String).join(" ")),
      info: (...args: unknown[]) => api.log(args.map(String).join(" ")),
      warn: (...args: unknown[]) => api.log(args.map(String).join(" ")),
      error: (...args: unknown[]) => api.log(args.map(String).join(" ")),
    },
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    URL,
    URLSearchParams,
    TextDecoder,
    TextEncoder,
    crypto: webcrypto,
    btoa: (value: string) => Buffer.from(value, "binary").toString("base64"),
    atob: (value: string) => Buffer.from(value, "base64").toString("binary"),
  });
  new Script(source, { filename: data.entry }).runInContext(context);
  return ((context.module as { exports?: ScriptModule }).exports ?? moduleExports) as ScriptModule;
}



function rpc(method: string, payload?: Record<string, unknown>) {
  const rpcId = createId();
  parentPort?.postMessage({
    type: "jarvis-script:rpc",
    rpcId,
    workerId: data.workerId,
    method,
    payload,
  });

  return new Promise((resolve, reject) => {
    pendingRpc.set(rpcId, { resolve, reject });
  });
}
