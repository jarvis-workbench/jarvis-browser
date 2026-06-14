import type { BrowserNavigationResult } from "../../shared/types";
import { needsHttpsPrefix } from "../../shared/utils";

export type NavigationTarget =
  | {
    kind: "browser";
    url: string;
  }
  | {
    kind: "external";
    url: string;
  }
  | {
    kind: "blocked";
    url: string;
    errorText: string;
  };

const browserProtocols = new Set([
  "http:",
  "https:",
  "file:",
  "jarvis-browser:",
]);

const externalProtocols = new Set([
  "mailto:",
  "tel:",
  "sms:",
]);



export function resolveNavigationTarget(rawUrl: string): NavigationTarget {
  const trimmed = rawUrl.trim();
  if (!trimmed) {
    return {
      kind: "blocked",
      url: trimmed,
      errorText: "网址不能为空",
    };
  }

  const candidate = needsHttpsPrefix(trimmed) ? `https://${trimmed}` : trimmed;
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return {
      kind: "blocked",
      url: trimmed,
      errorText: "无法识别的网址或协议",
    };
  }

  const normalizedUrl = parsed.toString();
  const blockedBrowserSchemeMessage = blockedTopLevelBrowserSchemeMessage(parsed);
  if (blockedBrowserSchemeMessage) {
    return {
      kind: "blocked",
      url: normalizedUrl,
      errorText: blockedBrowserSchemeMessage,
    };
  }

  if (browserProtocols.has(parsed.protocol) || isAllowedAboutPage(parsed)) {
    return {
      kind: "browser",
      url: normalizedUrl,
    };
  }

  if (externalProtocols.has(parsed.protocol) || isCustomExternalProtocol(parsed.protocol)) {
    return {
      kind: "external",
      url: normalizedUrl,
    };
  }

  return {
    kind: "blocked",
    url: normalizedUrl,
    errorText: `暂不支持协议 ${parsed.protocol}`,
  };
}

export function normalizeAddressInput(value: string) {
  const target = resolveNavigationTarget(value);
  return target.url;
}

export function toNavigationResult(target: NavigationTarget): BrowserNavigationResult {
  if (target.kind === "browser") {
    return {
      kind: "loaded",
      url: target.url,
    };
  }

  if (target.kind === "external") {
    return {
      kind: "external-opened",
      url: target.url,
    };
  }

  return {
    kind: "blocked",
    url: target.url,
    errorText: target.errorText,
  };
}



function isCustomExternalProtocol(protocol: string) {
  return protocol.endsWith(":")
    && !browserProtocols.has(protocol)
    && protocol !== "about:"
    && protocol !== "blob:"
    && protocol !== "data:"
    && protocol !== "javascript:"
    && protocol !== "http:"
    && protocol !== "https:";
}

function isAllowedAboutPage(parsed: URL) {
  return parsed.protocol === "about:" && parsed.pathname === "blank";
}

function blockedTopLevelBrowserSchemeMessage(parsed: URL) {
  switch (parsed.protocol) {
    case "data:":
    case "blob:":
    case "javascript:":
      return `暂不支持在标签页中直接打开 ${parsed.protocol} 地址`;
    case "about:":
      return isAllowedAboutPage(parsed) ? undefined : `暂不支持地址 ${parsed.toString()}`;
    default:
      return undefined;
  }
}
