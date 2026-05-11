"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.resolveNavigationTarget = resolveNavigationTarget;
exports.normalizeAddressInput = normalizeAddressInput;
exports.toNavigationResult = toNavigationResult;
const browserProtocols = new Set([
    "http:",
    "https:",
    "file:",
    "data:",
    "blob:",
    "about:",
    "javascript:",
    "jarvis-browser:",
]);
const externalProtocols = new Set([
    "mailto:",
    "tel:",
    "sms:",
]);
const explicitSchemePattern = /^[a-zA-Z][a-zA-Z\d+.-]*:/;
const hostLikePattern = /^(localhost|(\d{1,3}\.){3}\d{1,3}|[^/?#:]+\.[^/?#]+)(?::\d+)?(?:[/?#]|$)/i;
function resolveNavigationTarget(rawUrl) {
    const trimmed = rawUrl.trim();
    if (!trimmed) {
        return {
            kind: "blocked",
            url: trimmed,
            errorText: "网址不能为空",
        };
    }
    const candidate = needsHttpsPrefix(trimmed) ? `https://${trimmed}` : trimmed;
    let parsed;
    try {
        parsed = new URL(candidate);
    }
    catch {
        return {
            kind: "blocked",
            url: trimmed,
            errorText: "无法识别的网址或协议",
        };
    }
    const normalizedUrl = parsed.toString();
    if (browserProtocols.has(parsed.protocol)) {
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
function normalizeAddressInput(value) {
    const target = resolveNavigationTarget(value);
    return target.url;
}
function toNavigationResult(target) {
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
function needsHttpsPrefix(value) {
    if (hostLikePattern.test(value)) {
        return true;
    }
    if (explicitSchemePattern.test(value)) {
        return false;
    }
    if (value.startsWith("//")) {
        return true;
    }
    return false;
}
function isCustomExternalProtocol(protocol) {
    return protocol.endsWith(":")
        && !browserProtocols.has(protocol)
        && protocol !== "http:"
        && protocol !== "https:";
}
