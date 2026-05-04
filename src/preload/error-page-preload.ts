import { contextBridge, ipcRenderer } from "electron";

if (window.location.protocol === "jarvis-error:") {
  contextBridge.exposeInMainWorld("jarvisErrorPage", {
    reload: () => ipcRenderer.invoke("browser:reload-error-page"),
  });
}
