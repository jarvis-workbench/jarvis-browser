import { contextBridge, ipcRenderer } from "electron";

if (window.location.protocol === "jarvis-browser:" && window.location.hostname === "error") {
  contextBridge.exposeInMainWorld("jarvisInternalError", {
    reload: () => ipcRenderer.invoke("browser:reload-internal-error"),
  });
}
