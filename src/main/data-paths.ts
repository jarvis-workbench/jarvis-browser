import { app } from "electron";
import { homedir } from "node:os";
import { join } from "node:path";

const appRoot = join(homedir(), "jarvis-browser");
const userRoot = join(appRoot, "default");
const runtimeRoot = join(userRoot, "runtime");

export const dataPaths = {
  appRoot,
  userRoot,
  profileFile: join(userRoot, "profile.json"),
  global: {
    root: join(userRoot, "global"),
    metadataFile: join(userRoot, "global", "metadata.json"),
    downloadsFile: join(userRoot, "global", "downloads.json"),
    extensionsRoot: join(userRoot, "global", "extensions"),
    extensionsIndexFile: join(userRoot, "global", "extensions", "index.json"),
    extensionInstallDir: (extensionId: string) =>
      join(userRoot, "global", "extensions", "installed", extensionId),
    extensionSourceDir: (extensionId: string) =>
      join(userRoot, "global", "extensions", "installed", extensionId, "source"),
    extensionManifestFile: (extensionId: string) =>
      join(userRoot, "global", "extensions", "installed", extensionId, "manifest.json"),
    jarvisScriptsRoot: join(userRoot, "global", "jarvis-scripts"),
    jarvisScriptsIndexFile: join(userRoot, "global", "jarvis-scripts", "index.json"),
    jarvisScriptInstallDir: (scriptId: string) =>
      join(userRoot, "global", "jarvis-scripts", "installed", scriptId),
    jarvisScriptSourceDir: (scriptId: string) =>
      join(userRoot, "global", "jarvis-scripts", "installed", scriptId, "source"),
    jarvisScriptManifestFile: (scriptId: string) =>
      join(userRoot, "global", "jarvis-scripts", "installed", scriptId, "manifest.json"),
    jarvisScriptDataDir: (scriptId: string) =>
      join(userRoot, "global", "jarvis-scripts", "installed", scriptId, "data"),
  },
  sites: {
    root: join(userRoot, "sites"),
    indexFile: join(userRoot, "sites", "index.json"),
    siteRoot: (siteId: string) => join(userRoot, "sites", siteId),
    siteFile: (siteId: string) => join(userRoot, "sites", siteId, "site.json"),
    faviconRoot: (siteId: string) => join(userRoot, "sites", siteId, "favicon"),
    faviconMetadataFile: (siteId: string) => join(userRoot, "sites", siteId, "favicon", "metadata.json"),
    faviconFile: (siteId: string, extension: string) =>
      join(userRoot, "sites", siteId, "favicon", `favicon${extension}`),
    extensionsRoot: (siteId: string) => join(userRoot, "sites", siteId, "extensions"),
    extensionsIndexFile: (siteId: string) => join(userRoot, "sites", siteId, "extensions", "index.json"),
    extensionInstallDir: (siteId: string, extensionId: string) =>
      join(userRoot, "sites", siteId, "extensions", "installed", extensionId),
    extensionSourceDir: (siteId: string, extensionId: string) =>
      join(userRoot, "sites", siteId, "extensions", "installed", extensionId, "source"),
    extensionManifestFile: (siteId: string, extensionId: string) =>
      join(userRoot, "sites", siteId, "extensions", "installed", extensionId, "manifest.json"),
    jarvisScriptsRoot: (siteId: string) => join(userRoot, "sites", siteId, "jarvis-scripts"),
    jarvisScriptsIndexFile: (siteId: string) => join(userRoot, "sites", siteId, "jarvis-scripts", "index.json"),
    jarvisScriptInstallDir: (siteId: string, scriptId: string) =>
      join(userRoot, "sites", siteId, "jarvis-scripts", "installed", scriptId),
    jarvisScriptSourceDir: (siteId: string, scriptId: string) =>
      join(userRoot, "sites", siteId, "jarvis-scripts", "installed", scriptId, "source"),
    jarvisScriptManifestFile: (siteId: string, scriptId: string) =>
      join(userRoot, "sites", siteId, "jarvis-scripts", "installed", scriptId, "manifest.json"),
    jarvisScriptDataDir: (siteId: string, scriptId: string) =>
      join(userRoot, "sites", siteId, "jarvis-scripts", "installed", scriptId, "data"),
    sessionsRoot: (siteId: string) => join(userRoot, "sites", siteId, "sessions"),
    sessionsIndexFile: (siteId: string) => join(userRoot, "sites", siteId, "sessions", "index.json"),
    sessionRoot: (siteId: string, sessionId: string) =>
      join(userRoot, "sites", siteId, "sessions", sessionId),
    sessionFile: (siteId: string, sessionId: string) =>
      join(userRoot, "sites", siteId, "sessions", sessionId, "session.json"),
    sessionDownloadsDir: (siteId: string, sessionId: string) =>
      join(userRoot, "sites", siteId, "sessions", sessionId, "downloads"),
  },
  runtime: {
    root: runtimeRoot,
    userData: join(runtimeRoot, "user-data"),
    sessionData: join(runtimeRoot, "session-data"),
    extensionLoadRoot: join(runtimeRoot, "extension-load"),
  },
};

export function configureElectronDataPaths() {
  app.setPath("userData", dataPaths.runtime.userData);
  app.setPath("sessionData", dataPaths.runtime.sessionData);
}
