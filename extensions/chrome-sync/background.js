importScripts("state-format.js");

(function initChromeSyncBackground() {
  "use strict";

  const format = globalThis.ChromeSyncSession;
  const MESSAGE_PREFIX = "chrome-sync:";

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || typeof message.type !== "string" || !message.type.startsWith(MESSAGE_PREFIX)) {
      return false;
    }

    if (message.type === `${MESSAGE_PREFIX}export`) {
      exportActiveTabState(message)
        .then((result) => sendResponse({ ok: true, result }))
        .catch((error) => sendResponse({ ok: false, error: stringifyError(error) }));
      return true;
    }

    if (message.type === `${MESSAGE_PREFIX}import`) {
      importActiveTabState(message.state, message.options || {}, message.targetTab)
        .then((result) => sendResponse({ ok: true, result }))
        .catch((error) => sendResponse({ ok: false, error: stringifyError(error) }));
      return true;
    }

    return false;
  });

  async function exportActiveTabState(message) {
    const tab = await getActiveTab(message.targetTab);
    assertSupportedTab(tab);

    const state = format.createEmptyState({
      url: tab.url,
      exportedBy: message.exportedBy || format.detectBrowserName(),
      userAgent: message.userAgent || "",
    });
    const frames = await getTargetFrames(tab);
    const frameUrls = uniqueStrings(frames.map((frame) => frame.url).filter(format.isSupportedPageUrl));
    const frameOrigins = uniqueStrings(frameUrls.map(format.normalizeOrigin).filter(Boolean));
    state.metadata.frameOrigins = frameOrigins;

    state.cookies = await collectCookies(frameUrls, state.report.cookies);
    const seenOrigins = new Set();
    for (const frame of frames) {
      const origin = format.normalizeOrigin(frame.url);
      if (!origin || seenOrigins.has(origin)) {
        continue;
      }
      seenOrigins.add(origin);
      try {
        const response = await sendMessageToFrame(tab.id, frame.frameId, {
          type: `${MESSAGE_PREFIX}collect-origin`,
        });
        if (!response || !response.ok) {
          throw new Error(response && response.error ? response.error : "No response from frame.");
        }
        const result = response.result;
        const bucket = format.ensureOriginBucket(state, result.origin);
        Object.assign(bucket, result.bucket);
        mergeReports(state.report, result.report);
      } catch (error) {
        state.report.unsupported.push(`${origin}: ${stringifyError(error)}`);
      }
    }

    state.report.unsupported.push(
      "Service workers, HTTP auth cache, client certificates, OS keychain entries, and server-side device binding cannot be exported by a browser extension.",
    );

    return {
      state,
      summary: format.summarizeState(state),
    };
  }

  async function importActiveTabState(state, options, targetTab) {
    const validation = format.validateState(state);
    if (!validation.ok) {
      throw new Error(validation.errors.join(" "));
    }

    const tab = await getActiveTab(targetTab);
    assertSupportedTab(tab);

    const currentOrigin = format.normalizeOrigin(tab.url);
    const sourceOrigin = state.metadata && state.metadata.topOrigin;
    if (!options.allowOriginMismatch && sourceOrigin && currentOrigin && sourceOrigin !== currentOrigin) {
      throw new Error(`Origin mismatch: file is for ${sourceOrigin}, current tab is ${currentOrigin}.`);
    }

    const report = format.createReport();
    await importCookies(state.cookies || [], tab.url, report.cookies, options);

    const frames = await getTargetFrames(tab);
    const framesByOrigin = new Map();
    for (const frame of frames) {
      const origin = format.normalizeOrigin(frame.url);
      if (origin && !framesByOrigin.has(origin)) {
        framesByOrigin.set(origin, frame);
      }
    }

    for (const origin of Object.keys(state.origins || {})) {
      const frame = framesByOrigin.get(origin);
      if (!frame) {
        report.unsupported.push(`${origin}: no matching frame is open in the current tab.`);
        continue;
      }
      try {
        const response = await sendMessageToFrame(tab.id, frame.frameId, {
          type: `${MESSAGE_PREFIX}import-origin`,
          state,
          options,
        });
        if (!response || !response.ok) {
          throw new Error(response && response.error ? response.error : "No response from frame.");
        }
        mergeReports(report, response.result.report);
      } catch (error) {
        report.unsupported.push(`${origin}: ${stringifyError(error)}`);
      }
    }

    return {
      report,
      summary: format.summarizeState(state),
    };
  }

  async function collectCookies(urls, reportSection) {
    const cookieMap = new Map();
    const cookieFilters = [];

    for (const url of urls) {
      cookieFilters.push({ url });
      for (const domain of cookieDomainCandidates(url)) {
        cookieFilters.push({ domain });
      }
    }

    for (const filter of cookieFilters) {
      try {
        const cookies = await chromeCookiesGetAll(filter);
        for (const cookie of cookies) {
          cookieMap.set(cookieKey(cookie), sanitizeCookieForExport(cookie));
        }
      } catch (error) {
        format.addReportError(reportSection, `cookies.getAll ${JSON.stringify(filter)}: ${stringifyError(error)}`);
      }
    }

    const cookies = Array.from(cookieMap.values());
    reportSection.exported += cookies.length;
    return cookies;
  }

  async function importCookies(cookies, fallbackUrl, reportSection, options) {
    if (!Array.isArray(cookies) || cookies.length === 0) {
      return;
    }

    if (options.clearBeforeImport) {
      await clearLikelyCurrentCookies(cookies, fallbackUrl, reportSection);
    }

    for (const cookie of cookies) {
      try {
        await setCookieWithFallback(cookie, fallbackUrl);
        reportSection.imported += 1;
      } catch (error) {
        format.addReportError(reportSection, `${cookie.domain || ""} ${cookie.name || ""}: ${stringifyError(error)}`);
      }
    }
  }

  async function setCookieWithFallback(cookie, fallbackUrl) {
    const details = createCookieSetDetails(cookie, fallbackUrl);
    try {
      await chromeCookiesSet(details);
    } catch (error) {
      if (!details.partitionKey) {
        throw error;
      }
      const retryDetails = { ...details };
      delete retryDetails.partitionKey;
      await chromeCookiesSet(retryDetails);
    }
  }

  async function clearLikelyCurrentCookies(cookies, fallbackUrl, reportSection) {
    const removalMap = new Map();
    for (const cookie of cookies) {
      if (!cookie || !cookie.name) {
        continue;
      }
      const details = createCookieRemoveDetails(cookie, fallbackUrl);
      removalMap.set(`${details.url}\t${details.name}`, details);
    }

    for (const details of removalMap.values()) {
      try {
        await chromeCookiesRemove(details);
      } catch (error) {
        reportSection.skipped += 1;
        reportSection.errors.push(`cookies.remove ${details.name}: ${stringifyError(error)}`);
      }
    }
  }

  function createCookieSetDetails(cookie, fallbackUrl) {
    const url = synthesizeCookieUrl(cookie, fallbackUrl);
    const sameSite = normalizeSameSite(cookie.sameSite);
    const details = {
      url,
      name: cookie.name || "",
      value: cookie.value || "",
      path: cookie.path || "/",
      secure: Boolean(cookie.secure || sameSite === "no_restriction"),
      httpOnly: Boolean(cookie.httpOnly),
    };

    if (cookie.domain && !cookie.hostOnly) {
      details.domain = cookie.domain;
    }
    if (sameSite) {
      details.sameSite = sameSite;
    }
    if (!cookie.session && typeof cookie.expirationDate === "number") {
      details.expirationDate = cookie.expirationDate;
    }
    if (cookie.partitionKey) {
      details.partitionKey = cookie.partitionKey;
    }
    return details;
  }

  function createCookieRemoveDetails(cookie, fallbackUrl) {
    const details = {
      url: synthesizeCookieUrl(cookie, fallbackUrl),
      name: cookie.name || "",
    };
    if (cookie.storeId) {
      details.storeId = cookie.storeId;
    }
    return details;
  }

  function synthesizeCookieUrl(cookie, fallbackUrl) {
    let fallback;
    try {
      fallback = new URL(fallbackUrl);
    } catch (_error) {
      fallback = new URL("https://example.com/");
    }

    const rawDomain = cookie.domain ? String(cookie.domain).replace(/^\./, "") : fallback.hostname;
    const protocol = cookie.secure ? "https:" : fallback.protocol === "http:" ? "http:" : "https:";
    const path = cookie.path && String(cookie.path).startsWith("/") ? cookie.path : "/";
    return `${protocol}//${rawDomain}${path}`;
  }

  function normalizeSameSite(sameSite) {
    if (!sameSite || sameSite === "unspecified") {
      return undefined;
    }
    if (sameSite === "no_restriction" || sameSite === "lax" || sameSite === "strict") {
      return sameSite;
    }
    if (sameSite === "none") {
      return "no_restriction";
    }
    return undefined;
  }

  function sanitizeCookieForExport(cookie) {
    const output = {};
    for (const key of [
      "domain",
      "expirationDate",
      "hostOnly",
      "httpOnly",
      "name",
      "path",
      "sameSite",
      "secure",
      "session",
      "storeId",
      "value",
      "partitionKey",
    ]) {
      if (cookie[key] !== undefined) {
        output[key] = cookie[key];
      }
    }
    return output;
  }

  function cookieKey(cookie) {
    return [
      cookie.domain || "",
      cookie.path || "",
      cookie.name || "",
      cookie.storeId || "",
      cookie.partitionKey ? JSON.stringify(cookie.partitionKey) : "",
    ].join("\t");
  }

  function cookieDomainCandidates(url) {
    let hostname;
    try {
      hostname = new URL(url).hostname;
    } catch (_error) {
      return [];
    }
    if (!hostname || /^\d+\.\d+\.\d+\.\d+$/.test(hostname) || hostname === "localhost") {
      return [hostname].filter(Boolean);
    }

    const parts = hostname.split(".");
    const domains = new Set([hostname]);
    for (let index = 1; index < parts.length - 1; index += 1) {
      domains.add(parts.slice(index).join("."));
    }
    return Array.from(domains);
  }

  async function getTargetFrames(tab) {
    const topFrame = {
      frameId: 0,
      url: tab.url,
    };
    if (!chrome.webNavigation || typeof chrome.webNavigation.getAllFrames !== "function") {
      return [topFrame];
    }

    try {
      const frames = await new Promise((resolve) => {
        chrome.webNavigation.getAllFrames({ tabId: tab.id }, (items) => {
          if (chrome.runtime.lastError || !Array.isArray(items)) {
            resolve([topFrame]);
            return;
          }
          resolve(items);
        });
      });
      return frames
        .filter((frame) => frame && format.isSupportedPageUrl(frame.url))
        .map((frame) => ({ frameId: frame.frameId, url: frame.url }));
    } catch (_error) {
      return [topFrame];
    }
  }

  async function sendMessageToFrame(tabId, frameId, message) {
    try {
      return await sendTabsMessage(tabId, frameId, message);
    } catch (error) {
      if (!chrome.scripting || typeof chrome.scripting.executeScript !== "function") {
        throw error;
      }
      await injectContentScripts(tabId, frameId);
      return sendTabsMessage(tabId, frameId, message);
    }
  }

  function sendTabsMessage(tabId, frameId, message) {
    return new Promise((resolve, reject) => {
      const callback = (response) => {
        const lastError = chrome.runtime.lastError;
        if (lastError) {
          reject(new Error(lastError.message));
          return;
        }
        resolve(response);
      };

      try {
        chrome.tabs.sendMessage(tabId, message, { frameId }, callback);
      } catch (_error) {
        chrome.tabs.sendMessage(tabId, message, callback);
      }
    });
  }

  function injectContentScripts(tabId, frameId) {
    return new Promise((resolve, reject) => {
      chrome.scripting.executeScript(
        {
          target: { tabId, frameIds: [frameId] },
          files: ["state-format.js", "content-script.js"],
        },
        () => {
          const lastError = chrome.runtime.lastError;
          if (lastError) {
            reject(new Error(lastError.message));
            return;
          }
          resolve();
        },
      );
    });
  }

  function getActiveTab(fallbackTab) {
    return new Promise((resolve, reject) => {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        const lastError = chrome.runtime.lastError;
        if (lastError) {
          reject(new Error(lastError.message));
          return;
        }
        resolve(resolveSupportedTab(tabs && tabs[0], normalizeFallbackTab(fallbackTab)));
      });
    });
  }

  function resolveSupportedTab(tab, fallbackTab) {
    if (tab && format.isSupportedPageUrl(tab.url)) {
      return tab;
    }

    return fallbackTab;
  }

  function normalizeFallbackTab(tab) {
    if (!tab || typeof tab.url !== "string" || typeof tab.id !== "number") {
      return null;
    }

    return {
      id: tab.id,
      url: tab.url,
      title: tab.title || tab.url,
      active: true,
    };
  }

  function assertSupportedTab(tab) {
    if (!tab || !tab.id || !format.isSupportedPageUrl(tab.url)) {
      throw new Error("Open an http or https website tab before using Chrome Sync.");
    }
  }

  function chromeCookiesGetAll(filter) {
    return new Promise((resolve, reject) => {
      chrome.cookies.getAll(filter, (cookies) => {
        const lastError = chrome.runtime.lastError;
        if (lastError) {
          reject(new Error(lastError.message));
          return;
        }
        resolve(cookies || []);
      });
    });
  }

  function chromeCookiesSet(details) {
    if (globalThis.jarvisExtensionPopup && typeof globalThis.jarvisExtensionPopup.cookiesSet === "function") {
      return globalThis.jarvisExtensionPopup.cookiesSet(toJarvisCookieSetDetails(details));
    }
    if (isJarvisPopupBridgeAvailable()) {
      return sendJarvisCookieMessage("set", toJarvisCookieSetDetails(details));
    }

    return new Promise((resolve, reject) => {
      chrome.cookies.set(details, (cookie) => {
        const lastError = chrome.runtime.lastError;
        if (lastError || !cookie) {
          reject(new Error(lastError ? lastError.message : "Cookie was not set."));
          return;
        }
        resolve(cookie);
      });
    });
  }

  function chromeCookiesRemove(details) {
    if (globalThis.jarvisExtensionPopup && typeof globalThis.jarvisExtensionPopup.cookiesRemove === "function") {
      return globalThis.jarvisExtensionPopup.cookiesRemove(toJarvisCookieRemoveDetails(details));
    }
    if (isJarvisPopupBridgeAvailable()) {
      return sendJarvisCookieMessage("remove", toJarvisCookieRemoveDetails(details));
    }

    return new Promise((resolve) => {
      chrome.cookies.remove(details, () => resolve());
    });
  }

  function isJarvisPopupBridgeAvailable() {
    return typeof chrome !== "undefined"
      && chrome.runtime
      && typeof chrome.runtime.sendMessage === "function";
  }

  function sendJarvisCookieMessage(action, details) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({
        type: `${MESSAGE_PREFIX}jarvis-cookie`,
        action,
        details,
      }, (response) => {
        const lastError = chrome.runtime.lastError;
        if (lastError) {
          reject(new Error(lastError.message));
          return;
        }
        if (!response || !response.ok) {
          reject(new Error(response && response.error ? response.error : "Jarvis cookie bridge did not respond."));
          return;
        }
        resolve();
      });
    });
  }

  function toJarvisCookieSetDetails(details) {
    const output = {
      url: details.url,
      name: details.name,
      value: details.value,
      path: details.path,
      secure: details.secure,
      httpOnly: details.httpOnly,
      expirationDate: details.expirationDate,
      sameSite: details.sameSite,
    };
    if (details.domain) {
      output.domain = details.domain;
    }
    return output;
  }

  function toJarvisCookieRemoveDetails(details) {
    return {
      url: details.url,
      name: details.name,
    };
  }

  function mergeReports(target, source) {
    if (!source) {
      return;
    }
    for (const key of ["cookies", "localStorage", "sessionStorage", "indexedDB", "cacheStorage"]) {
      if (!target[key] || !source[key]) {
        continue;
      }
      target[key].exported += source[key].exported || 0;
      target[key].imported += source[key].imported || 0;
      target[key].failed += source[key].failed || 0;
      target[key].skipped += source[key].skipped || 0;
      target[key].errors.push(...(source[key].errors || []));
    }
    target.unsupported.push(...(source.unsupported || []));
  }

  function uniqueStrings(values) {
    return Array.from(new Set(values));
  }

  function stringifyError(error) {
    return error && error.message ? error.message : String(error);
  }
})();
