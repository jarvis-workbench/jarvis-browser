(function initJarvisLoginStatePopup() {
  "use strict";

  const format = globalThis.JarvisLoginState;
  const MESSAGE_PREFIX = "jarvis-login-state:";
  const elements = {
    allowOriginMismatch: document.getElementById("allow-origin-mismatch"),
    browserName: document.getElementById("browser-name"),
    clearBeforeImport: document.getElementById("clear-before-import"),
    currentOrigin: document.getElementById("current-origin"),
    exportState: document.getElementById("export-state"),
    importState: document.getElementById("import-state"),
    preview: document.getElementById("preview"),
    previewOrigin: document.getElementById("preview-origin"),
    previewSummary: document.getElementById("preview-summary"),
    previewTime: document.getElementById("preview-time"),
    report: document.getElementById("report"),
    stateFile: document.getElementById("state-file"),
    status: document.getElementById("status"),
  };

  let currentTab = null;
  let pendingState = null;

  document.addEventListener("DOMContentLoaded", init);
  elements.exportState.addEventListener("click", exportState);
  elements.stateFile.addEventListener("change", readImportFile);
  elements.importState.addEventListener("click", importState);

  async function init() {
    elements.browserName.textContent = format.detectBrowserName();
    try {
      currentTab = await getActiveTab();
      elements.currentOrigin.textContent = format.normalizeOrigin(currentTab.url) || currentTab.url || "当前页面不可用";
      const isSupported = currentTab && format.isSupportedPageUrl(currentTab.url);
      elements.exportState.disabled = !isSupported;
      elements.importState.disabled = !isSupported || !pendingState;
      if (!isSupported) {
        setStatus("请先打开一个 http/https 网站页面。", "error");
      }
    } catch (error) {
      setStatus(stringifyError(error), "error");
    }
  }

  async function exportState() {
    setBusy(true, "正在导出当前网站状态...");
    clearReport();
    try {
      const response = await sendRuntimeMessage({
        type: `${MESSAGE_PREFIX}export`,
        targetTab: currentTab,
        exportedBy: format.detectBrowserName(),
        userAgent: navigator.userAgent,
      });
      if (!response.ok) {
        throw new Error(response.error || "导出失败。");
      }

      const state = response.result.state;
      const summary = response.result.summary;
      downloadStateFile(state);
      renderReport("导出完成", state.report, summary);
      setStatus("已生成状态文件。", "success");
    } catch (error) {
      setStatus(stringifyError(error), "error");
    } finally {
      setBusy(false);
    }
  }

  async function readImportFile(event) {
    const file = event.target.files && event.target.files[0];
    pendingState = null;
    elements.importState.disabled = true;
    clearReport();
    if (!file) {
      return;
    }

    try {
      const state = JSON.parse(await file.text());
      const validation = format.validateState(state);
      if (!validation.ok) {
        throw new Error(validation.errors.join(" "));
      }
      pendingState = state;
      renderPreview(state);
      elements.importState.disabled = !format.isSupportedPageUrl(currentTab && currentTab.url);
      setStatus("状态文件已读取，确认后可导入。", "success");
    } catch (error) {
      elements.preview.classList.add("hidden");
      setStatus(`文件无效：${stringifyError(error)}`, "error");
    }
  }

  async function importState() {
    if (!pendingState) {
      setStatus("请先选择状态文件。", "error");
      return;
    }

    const currentOrigin = format.normalizeOrigin(currentTab.url);
    const sourceOrigin = pendingState.metadata && pendingState.metadata.topOrigin;
    if (sourceOrigin && currentOrigin && sourceOrigin !== currentOrigin && !elements.allowOriginMismatch.checked) {
      setStatus("来源 origin 与当前页面不同；确认需要跨站导入后再勾选允许。", "error");
      return;
    }

    setBusy(true, "正在导入状态...");
    clearReport();
    try {
      const response = await sendRuntimeMessage({
        type: `${MESSAGE_PREFIX}import`,
        targetTab: currentTab,
        state: pendingState,
        options: {
          allowOriginMismatch: elements.allowOriginMismatch.checked,
          clearBeforeImport: elements.clearBeforeImport.checked,
        },
      });
      if (!response.ok) {
        throw new Error(response.error || "导入失败。");
      }
      renderReport("导入完成，刷新页面后验证登录态", response.result.report, response.result.summary);
      setStatus("导入完成，请刷新当前页面。", "success");
    } catch (error) {
      setStatus(stringifyError(error), "error");
    } finally {
      setBusy(false);
    }
  }

  function renderPreview(state) {
    const summary = format.summarizeState(state);
    elements.previewOrigin.textContent = state.metadata.topOrigin || "未知";
    elements.previewTime.textContent = state.metadata.exportedAt || "未知";
    elements.previewSummary.innerHTML = "";
    for (const item of summaryItems(summary)) {
      const node = document.createElement("div");
      node.className = "summary-item";
      node.innerHTML = `<span>${escapeHtml(item.label)}</span><strong>${escapeHtml(String(item.value))}</strong>`;
      elements.previewSummary.appendChild(node);
    }
    elements.preview.classList.remove("hidden");
  }

  function renderReport(title, report, summary) {
    const lines = [title, "", ...summaryItems(summary).map((item) => `${item.label}: ${item.value}`), ""];
    for (const key of ["cookies", "localStorage", "sessionStorage", "indexedDB", "cacheStorage"]) {
      const section = report[key] || {};
      lines.push(`${key}: exported ${section.exported || 0}, imported ${section.imported || 0}, skipped ${section.skipped || 0}, failed ${section.failed || 0}`);
      for (const error of section.errors || []) {
        lines.push(`  - ${error}`);
      }
    }
    for (const item of report.unsupported || []) {
      lines.push(`unsupported: ${item}`);
    }
    elements.report.textContent = lines.join("\n");
    elements.report.classList.remove("hidden");
  }

  function clearReport() {
    elements.report.textContent = "";
    elements.report.classList.add("hidden");
  }

  function summaryItems(summary) {
    return [
      { label: "Origins", value: summary.origins },
      { label: "Cookies", value: summary.cookies },
      { label: "LocalStorage", value: summary.localStorage },
      { label: "SessionStorage", value: summary.sessionStorage },
      { label: "IndexedDB Records", value: summary.indexedDBRecords },
      { label: "Cache Entries", value: summary.cacheEntries },
    ];
  }

  function downloadStateFile(state) {
    const json = JSON.stringify(state, null, 2);
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = createDownloadFilename(state);
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function createDownloadFilename(state) {
    const origin = state.metadata && state.metadata.topOrigin ? state.metadata.topOrigin : "site";
    const host = (() => {
      try {
        return new URL(origin).hostname;
      } catch (_error) {
        return "site";
      }
    })();
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    return `${host}-jarvis-login-state-${stamp}.json`;
  }

  function sendRuntimeMessage(message) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(message, (response) => {
        const lastError = chrome.runtime.lastError;
        if (lastError) {
          resolve({ ok: false, error: lastError.message });
          return;
        }
        resolve(response || { ok: false, error: "No response from extension background." });
      });
    });
  }

  function getActiveTab() {
    return new Promise((resolve, reject) => {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        const lastError = chrome.runtime.lastError;
        if (lastError) {
          reject(new Error(lastError.message));
          return;
        }
        resolve(resolveSupportedTab(tabs && tabs[0], getJarvisTargetTab()));
      });
    });
  }

  function resolveSupportedTab(tab, fallbackTab) {
    if (tab && format.isSupportedPageUrl(tab.url)) {
      return tab;
    }

    return fallbackTab;
  }

  function getJarvisTargetTab() {
    const params = new URLSearchParams(location.search);
    const tabId = Number(params.get("jarvisTabId"));
    const tabUrl = params.get("jarvisTabUrl");
    if (!Number.isFinite(tabId) || !tabUrl) {
      return null;
    }

    return {
      id: tabId,
      url: tabUrl,
      title: params.get("jarvisTabTitle") || tabUrl,
      active: true,
    };
  }

  function setBusy(isBusy, message) {
    elements.exportState.disabled = isBusy || !format.isSupportedPageUrl(currentTab && currentTab.url);
    elements.importState.disabled = isBusy || !pendingState || !format.isSupportedPageUrl(currentTab && currentTab.url);
    if (message) {
      setStatus(message);
    }
  }

  function setStatus(message, kind) {
    elements.status.textContent = message || "";
    elements.status.className = `status${kind ? ` ${kind}` : ""}`;
  }

  function escapeHtml(value) {
    return value.replace(/[&<>"']/g, (char) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#039;",
    }[char]));
  }

  function stringifyError(error) {
    return error && error.message ? error.message : String(error);
  }
})();
