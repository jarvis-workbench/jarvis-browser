import { parentPort, workerData } from "node:worker_threads";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { Script, createContext } from "node:vm";
import type { JarvisScript } from "../../shared/types";

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
  log: (message) => parentPort?.postMessage({ type: "jarvis-script:log", message }),
  request: async (input, init) => {
    assertPermission("http");
    const response = await fetch(input, init);
    const contentType = response.headers.get("content-type") ?? "";
    if (contentType.includes("application/json")) {
      return response.json();
    }
    return response.text();
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
  });
  new Script(source, { filename: data.entry }).runInContext(context);
  return ((context.module as { exports?: ScriptModule }).exports ?? moduleExports) as ScriptModule;
}

function formatError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function rpc(method: string, payload?: Record<string, unknown>) {
  const rpcId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
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
