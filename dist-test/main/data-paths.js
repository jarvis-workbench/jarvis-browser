"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.dataPaths = void 0;
exports.configureElectronDataPaths = configureElectronDataPaths;
const electron_1 = require("electron");
const node_os_1 = require("node:os");
const node_path_1 = require("node:path");
const appRoot = (0, node_path_1.join)((0, node_os_1.homedir)(), "jarvis-browser");
const userRoot = (0, node_path_1.join)(appRoot, "default");
const runtimeRoot = (0, node_path_1.join)(userRoot, "runtime");
exports.dataPaths = {
    appRoot,
    userRoot,
    profileFile: (0, node_path_1.join)(userRoot, "profile.json"),
    global: {
        root: (0, node_path_1.join)(userRoot, "global"),
        metadataFile: (0, node_path_1.join)(userRoot, "global", "metadata.json"),
        downloadsFile: (0, node_path_1.join)(userRoot, "global", "downloads.json"),
        extensionsRoot: (0, node_path_1.join)(userRoot, "global", "extensions"),
        extensionsIndexFile: (0, node_path_1.join)(userRoot, "global", "extensions", "index.json"),
        extensionInstallDir: (extensionId) => (0, node_path_1.join)(userRoot, "global", "extensions", "installed", extensionId),
        extensionSourceDir: (extensionId) => (0, node_path_1.join)(userRoot, "global", "extensions", "installed", extensionId, "source"),
        extensionManifestFile: (extensionId) => (0, node_path_1.join)(userRoot, "global", "extensions", "installed", extensionId, "manifest.json"),
        jarvisScriptsRoot: (0, node_path_1.join)(userRoot, "global", "jarvis-scripts"),
        jarvisScriptsIndexFile: (0, node_path_1.join)(userRoot, "global", "jarvis-scripts", "index.json"),
        jarvisScriptInstallDir: (scriptId) => (0, node_path_1.join)(userRoot, "global", "jarvis-scripts", "installed", scriptId),
        jarvisScriptSourceDir: (scriptId) => (0, node_path_1.join)(userRoot, "global", "jarvis-scripts", "installed", scriptId, "source"),
        jarvisScriptManifestFile: (scriptId) => (0, node_path_1.join)(userRoot, "global", "jarvis-scripts", "installed", scriptId, "manifest.json"),
        jarvisScriptDataDir: (scriptId) => (0, node_path_1.join)(userRoot, "global", "jarvis-scripts", "installed", scriptId, "data"),
    },
    sites: {
        root: (0, node_path_1.join)(userRoot, "sites"),
        indexFile: (0, node_path_1.join)(userRoot, "sites", "index.json"),
        siteRoot: (siteId) => (0, node_path_1.join)(userRoot, "sites", siteId),
        siteFile: (siteId) => (0, node_path_1.join)(userRoot, "sites", siteId, "site.json"),
        faviconRoot: (siteId) => (0, node_path_1.join)(userRoot, "sites", siteId, "favicon"),
        faviconMetadataFile: (siteId) => (0, node_path_1.join)(userRoot, "sites", siteId, "favicon", "metadata.json"),
        faviconFile: (siteId, extension) => (0, node_path_1.join)(userRoot, "sites", siteId, "favicon", `favicon${extension}`),
        extensionsRoot: (siteId) => (0, node_path_1.join)(userRoot, "sites", siteId, "extensions"),
        extensionsIndexFile: (siteId) => (0, node_path_1.join)(userRoot, "sites", siteId, "extensions", "index.json"),
        extensionInstallDir: (siteId, extensionId) => (0, node_path_1.join)(userRoot, "sites", siteId, "extensions", "installed", extensionId),
        extensionSourceDir: (siteId, extensionId) => (0, node_path_1.join)(userRoot, "sites", siteId, "extensions", "installed", extensionId, "source"),
        extensionManifestFile: (siteId, extensionId) => (0, node_path_1.join)(userRoot, "sites", siteId, "extensions", "installed", extensionId, "manifest.json"),
        jarvisScriptsRoot: (siteId) => (0, node_path_1.join)(userRoot, "sites", siteId, "jarvis-scripts"),
        jarvisScriptsIndexFile: (siteId) => (0, node_path_1.join)(userRoot, "sites", siteId, "jarvis-scripts", "index.json"),
        jarvisScriptInstallDir: (siteId, scriptId) => (0, node_path_1.join)(userRoot, "sites", siteId, "jarvis-scripts", "installed", scriptId),
        jarvisScriptSourceDir: (siteId, scriptId) => (0, node_path_1.join)(userRoot, "sites", siteId, "jarvis-scripts", "installed", scriptId, "source"),
        jarvisScriptManifestFile: (siteId, scriptId) => (0, node_path_1.join)(userRoot, "sites", siteId, "jarvis-scripts", "installed", scriptId, "manifest.json"),
        jarvisScriptDataDir: (siteId, scriptId) => (0, node_path_1.join)(userRoot, "sites", siteId, "jarvis-scripts", "installed", scriptId, "data"),
        sessionsRoot: (siteId) => (0, node_path_1.join)(userRoot, "sites", siteId, "sessions"),
        sessionsIndexFile: (siteId) => (0, node_path_1.join)(userRoot, "sites", siteId, "sessions", "index.json"),
        sessionRoot: (siteId, sessionId) => (0, node_path_1.join)(userRoot, "sites", siteId, "sessions", sessionId),
        sessionFile: (siteId, sessionId) => (0, node_path_1.join)(userRoot, "sites", siteId, "sessions", sessionId, "session.json"),
        sessionDownloadsDir: (siteId, sessionId) => (0, node_path_1.join)(userRoot, "sites", siteId, "sessions", sessionId, "downloads"),
    },
    runtime: {
        root: runtimeRoot,
        userData: (0, node_path_1.join)(runtimeRoot, "user-data"),
        sessionData: (0, node_path_1.join)(runtimeRoot, "session-data"),
    },
};
function configureElectronDataPaths() {
    electron_1.app.setPath("userData", exports.dataPaths.runtime.userData);
    electron_1.app.setPath("sessionData", exports.dataPaths.runtime.sessionData);
}
