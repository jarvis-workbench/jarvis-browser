"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const node_worker_threads_1 = require("node:worker_threads");
const promises_1 = require("node:fs/promises");
const node_path_1 = require("node:path");
const node_vm_1 = require("node:vm");
const data = node_worker_threads_1.workerData;
const api = {
    script: data.script,
    readText: async (relativePath) => (0, promises_1.readFile)(resolveDataPath(relativePath), "utf8"),
    writeText: async (relativePath, value) => {
        const filePath = resolveDataPath(relativePath);
        await (0, promises_1.mkdir)((0, node_path_1.dirname)(filePath), { recursive: true });
        await (0, promises_1.writeFile)(filePath, value, "utf8");
    },
    log: (message) => node_worker_threads_1.parentPort?.postMessage({ type: "jarvis-script:log", message }),
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
let scriptModule;
const pendingRpc = new Map();
void loadScriptModule().then(async (module) => {
    scriptModule = module;
    await scriptModule.activate?.(api);
    node_worker_threads_1.parentPort?.postMessage({ type: "jarvis-script:ready" });
}).catch((error) => {
    node_worker_threads_1.parentPort?.postMessage({ type: "jarvis-script:error", error: formatError(error) });
});
node_worker_threads_1.parentPort?.on("message", (message) => {
    if (message.type === "jarvis-monitor:event") {
        void Promise.resolve(scriptModule?.onMonitorEvent?.(message.event, api)).catch((error) => {
            node_worker_threads_1.parentPort?.postMessage({ type: "jarvis-script:error", error: formatError(error) });
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
        void Promise.resolve(scriptModule?.deactivate?.(api)).finally(() => node_worker_threads_1.parentPort?.close());
    }
});
function resolveDataPath(relativePath) {
    const targetPath = (0, node_path_1.resolve)(data.dataDir, relativePath);
    const rootPath = (0, node_path_1.resolve)(data.dataDir);
    if (targetPath !== rootPath && !targetPath.startsWith(`${rootPath}/`)) {
        throw new Error("脚本数据路径越界");
    }
    return targetPath;
}
function assertPermission(permission) {
    if ((data.script.manifest.permissions ?? []).includes(permission)) {
        return;
    }
    throw new Error(`${data.script.name} 缺少权限：${permission}`);
}
async function loadScriptModule() {
    const source = await (0, promises_1.readFile)(data.entry, "utf8");
    const moduleExports = {};
    const context = (0, node_vm_1.createContext)({
        exports: moduleExports,
        module: { exports: moduleExports },
        console: {
            log: (...args) => api.log(args.map(String).join(" ")),
            info: (...args) => api.log(args.map(String).join(" ")),
            warn: (...args) => api.log(args.map(String).join(" ")),
            error: (...args) => api.log(args.map(String).join(" ")),
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
    new node_vm_1.Script(source, { filename: data.entry }).runInContext(context);
    return (context.module.exports ?? moduleExports);
}
function formatError(error) {
    return error instanceof Error ? error.message : String(error);
}
function rpc(method, payload) {
    const rpcId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    node_worker_threads_1.parentPort?.postMessage({
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
