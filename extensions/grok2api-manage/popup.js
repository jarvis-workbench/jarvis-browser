(function initGrok2ApiManagePopup() {
  "use strict";

  const DEVICE_AUTH_BASE = "https://accounts.x.ai/oauth2/device";
  const SSO_COOKIE_NAME = "sso";
  const params = new URLSearchParams(window.location.search);

  const state = {
    activeTab: null,
    ssoValue: "",
    pageTitle: "",
  };

  const elements = {
    contextLabel: document.getElementById("context-label"),
    tabSso: document.getElementById("tab-sso"),
    tabDeviceAuth: document.getElementById("tab-device-auth"),
    panelSso: document.getElementById("panel-sso"),
    panelDeviceAuth: document.getElementById("panel-device-auth"),
    ssoValue: document.getElementById("sso-value"),
    ssoBadge: document.getElementById("sso-badge"),
    copySso: document.getElementById("copy-sso"),
    exportSso: document.getElementById("export-sso"),
    deviceCode: document.getElementById("device-code"),
    startAuth: document.getElementById("start-auth"),
    status: document.getElementById("status"),
  };

  document.addEventListener("DOMContentLoaded", () => {
    elements.tabSso?.addEventListener("click", () => switchTab("sso"));
    elements.tabDeviceAuth?.addEventListener("click", () => switchTab("device-auth"));
    elements.copySso?.addEventListener("click", copySso);
    elements.exportSso?.addEventListener("click", exportSso);
    elements.deviceCode?.addEventListener("input", updateDeviceAuthState);
    elements.deviceCode?.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        void startDeviceAuth();
      }
    });
    elements.startAuth?.addEventListener("click", startDeviceAuth);
    void init();
  });

  async function init() {
    try {
      state.activeTab = await resolveActiveTab();
      state.pageTitle = state.activeTab?.title || deriveTitleFromUrl(state.activeTab?.url) || "grok";
      updateContextLabel();

      if (!isGrokRelatedUrl(state.activeTab?.url || "")) {
        setStatus("请在 grok.com 会话标签中打开本插件。", "error");
      }

      await loadSsoCookie();
      updateDeviceAuthState();
    } catch (error) {
      setStatus(stringifyError(error), "error");
      setSsoValue("");
      updateDeviceAuthState();
    }
  }

  function updateContextLabel() {
    if (!elements.contextLabel) {
      return;
    }

    const title = state.pageTitle || "当前会话";
    const host = deriveTitleFromUrl(state.activeTab?.url || "");
    elements.contextLabel.textContent = host && host !== title ? `${title} · ${host}` : title;
    elements.contextLabel.title = state.activeTab?.url || title;
  }

  async function loadSsoCookie() {
    const tabUrl = state.activeTab?.url || "";
    if (!tabUrl || !/^https?:\/\//i.test(tabUrl)) {
      setSsoValue("");
      setStatus("当前标签无法读取 cookie。", "error");
      return;
    }

    const candidates = cookieLookupCandidates(tabUrl);
    let value = "";
    for (const candidate of candidates) {
      try {
        const cookies = await getCookies(candidate);
        const ssoCookie = Array.isArray(cookies)
          ? cookies.find((cookie) => cookie?.name === SSO_COOKIE_NAME)
          : undefined;
        const nextValue = typeof ssoCookie?.value === "string" ? ssoCookie.value.trim() : "";
        if (nextValue) {
          value = nextValue;
          break;
        }
      } catch {
        // try next candidate
      }
    }

    setSsoValue(value);
    if (!value) {
      setStatus("当前对话未登录。", "error");
    } else {
      setStatus("", "info");
    }
  }

  function cookieLookupCandidates(tabUrl) {
    const candidates = [
      { url: tabUrl, name: SSO_COOKIE_NAME },
      { url: "https://grok.com/", name: SSO_COOKIE_NAME },
      { url: "https://accounts.x.ai/", name: SSO_COOKIE_NAME },
      { domain: "grok.com", name: SSO_COOKIE_NAME },
      { domain: "x.ai", name: SSO_COOKIE_NAME },
    ];

    try {
      const origin = new URL(tabUrl).origin;
      candidates.unshift({ url: `${origin}/`, name: SSO_COOKIE_NAME });
    } catch {
      // ignore invalid tab url
    }

    const unique = [];
    const seen = new Set();
    for (const candidate of candidates) {
      const key = JSON.stringify(candidate);
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      unique.push(candidate);
    }
    return unique;
  }

  function setSsoValue(value) {
    state.ssoValue = value || "";
    if (elements.ssoValue) {
      elements.ssoValue.value = state.ssoValue;
      elements.ssoValue.placeholder = "当前对话未登录";
    }

    const enabled = Boolean(state.ssoValue);
    if (elements.copySso) {
      elements.copySso.disabled = !enabled;
    }
    if (elements.exportSso) {
      elements.exportSso.disabled = !enabled;
    }
    if (elements.ssoBadge) {
      elements.ssoBadge.textContent = enabled ? "已登录" : "未登录";
      elements.ssoBadge.classList.toggle("is-ready", enabled);
    }
  }

  async function copySso() {
    if (!state.ssoValue) {
      return;
    }

    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(state.ssoValue);
      } else {
        elements.ssoValue?.focus();
        elements.ssoValue?.select();
        document.execCommand("copy");
      }
      setStatus("SSO 已复制。", "success");
    } catch (error) {
      setStatus(`复制失败：${stringifyError(error)}`, "error");
    }
  }

  function exportSso() {
    if (!state.ssoValue) {
      return;
    }

    try {
      const filename = `${sanitizeFilename(state.pageTitle || "grok")}.text`;
      const blob = new Blob([state.ssoValue], { type: "text/plain;charset=utf-8" });
      const objectUrl = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = objectUrl;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(objectUrl);
      setStatus(`已导出 ${filename}`, "success");
    } catch (error) {
      setStatus(`导出失败：${stringifyError(error)}`, "error");
    }
  }

  function updateDeviceAuthState() {
    const code = normalizeDeviceCode(elements.deviceCode?.value || "");
    if (elements.startAuth) {
      elements.startAuth.disabled = !code;
    }
  }

  async function startDeviceAuth() {
    const code = normalizeDeviceCode(elements.deviceCode?.value || "");
    if (!code) {
      setStatus("请先输入设备码。", "error");
      return;
    }

    const authUrl = `${DEVICE_AUTH_BASE}?user_code=${encodeURIComponent(code)}`;
    try {
      if (elements.startAuth) {
        elements.startAuth.disabled = true;
      }
      setStatus("正在打开 Device Auth 标签...");
      await createSessionTab(authUrl);
      setStatus("已新建当前会话标签并打开授权页。", "success");
    } catch (error) {
      setStatus(`开始授权失败：${stringifyError(error)}`, "error");
    } finally {
      updateDeviceAuthState();
    }
  }

  function switchTab(tabId) {
    const isSso = tabId === "sso";
    elements.tabSso?.classList.toggle("is-active", isSso);
    elements.tabDeviceAuth?.classList.toggle("is-active", !isSso);
    elements.tabSso?.setAttribute("aria-selected", String(isSso));
    elements.tabDeviceAuth?.setAttribute("aria-selected", String(!isSso));

    if (elements.panelSso) {
      elements.panelSso.hidden = !isSso;
      elements.panelSso.classList.toggle("is-active", isSso);
    }
    if (elements.panelDeviceAuth) {
      elements.panelDeviceAuth.hidden = isSso;
      elements.panelDeviceAuth.classList.toggle("is-active", !isSso);
    }
  }

  async function resolveActiveTab() {
    const jarvisTab = readJarvisTabFromQuery();
    if (jarvisTab) {
      return jarvisTab;
    }

    return queryActiveTab();
  }

  function readJarvisTabFromQuery() {
    const tabUrl = params.get("jarvisTabUrl");
    if (!tabUrl) {
      return null;
    }

    return {
      id: params.get("jarvisBrowserTabId") || params.get("jarvisTabId") || undefined,
      url: tabUrl,
      title: params.get("jarvisTabTitle") || deriveTitleFromUrl(tabUrl) || "grok",
      siteId: params.get("jarvisSiteId") || undefined,
      sessionId: params.get("jarvisSessionId") || undefined,
    };
  }

  function queryActiveTab() {
    return new Promise((resolve, reject) => {
      if (!chrome.tabs?.query) {
        resolve(null);
        return;
      }

      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        const error = chrome.runtime?.lastError;
        if (error) {
          reject(new Error(error.message));
          return;
        }
        resolve(tabs?.[0] || null);
      });
    });
  }

  async function getCookies(details) {
    if (globalThis.jarvisExtensionPopup?.cookiesGet) {
      return globalThis.jarvisExtensionPopup.cookiesGet(details);
    }

    return new Promise((resolve, reject) => {
      if (!chrome.cookies?.getAll) {
        resolve([]);
        return;
      }

      chrome.cookies.getAll(details, (cookies) => {
        const error = chrome.runtime?.lastError;
        if (error) {
          reject(new Error(error.message));
          return;
        }
        resolve(cookies || []);
      });
    });
  }

  async function createSessionTab(url) {
    if (globalThis.jarvisExtensionPopup?.createTab) {
      return globalThis.jarvisExtensionPopup.createTab({
        url,
        openerTabId: state.activeTab?.id,
        siteId: state.activeTab?.siteId || params.get("jarvisSiteId") || undefined,
        sessionId: state.activeTab?.sessionId || params.get("jarvisSessionId") || undefined,
      });
    }

    return new Promise((resolve, reject) => {
      if (!chrome.tabs?.create) {
        reject(new Error("当前环境不支持创建标签。"));
        return;
      }

      chrome.tabs.create({ url, active: true }, (tab) => {
        const error = chrome.runtime?.lastError;
        if (error) {
          reject(new Error(error.message));
          return;
        }
        resolve(tab);
      });
    });
  }

  function normalizeDeviceCode(value) {
    return String(value || "")
      .trim()
      .replace(/\s+/g, "")
      .toUpperCase();
  }

  function isGrokRelatedUrl(url) {
    try {
      const host = new URL(url).hostname.toLowerCase();
      return host === "grok.com"
        || host.endsWith(".grok.com")
        || host === "x.ai"
        || host.endsWith(".x.ai");
    } catch {
      return false;
    }
  }

  function deriveTitleFromUrl(url) {
    try {
      return new URL(url).hostname || "";
    } catch {
      return "";
    }
  }

  function sanitizeFilename(value) {
    const cleaned = String(value || "grok")
      .replace(/[\\/:*?"<>|]+/g, "_")
      .replace(/\s+/g, " ")
      .trim();
    return cleaned || "grok";
  }

  function setStatus(text, tone) {
    if (!elements.status) {
      return;
    }

    elements.status.textContent = text || "";
    elements.status.classList.toggle("is-error", tone === "error");
    elements.status.classList.toggle("is-success", tone === "success");
  }

  function stringifyError(error) {
    if (error instanceof Error) {
      return error.message;
    }
    return String(error || "未知错误");
  }
})();
