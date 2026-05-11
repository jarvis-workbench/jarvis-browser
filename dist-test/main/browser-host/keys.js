"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createViewKey = createViewKey;
exports.createSessionTabId = createSessionTabId;
exports.createTabViewKey = createTabViewKey;
exports.parseViewKey = parseViewKey;
exports.parseTabViewKeyParts = parseTabViewKeyParts;
exports.parseTabViewKey = parseTabViewKey;
exports.parseSessionTabId = parseSessionTabId;
const tabViewKeyPrefix = "tab:";
function createViewKey(siteId, sessionId) {
    return createSessionTabId(siteId, sessionId);
}
function createSessionTabId(siteId, sessionId) {
    return `${siteId}:${sessionId}`;
}
function createTabViewKey(tabId) {
    return `${tabViewKeyPrefix}${tabId}`;
}
function parseViewKey(viewKey) {
    const parts = parseTabViewKeyParts(viewKey);
    if (!parts.siteId || parts.sessionId === undefined) {
        throw new Error(`View key is not a session tab: ${viewKey}`);
    }
    return {
        tabId: parts.tabId,
        siteId: parts.siteId,
        sessionId: parts.sessionId,
    };
}
function parseTabViewKeyParts(viewKey) {
    const tabId = parseTabViewKey(viewKey);
    if (tabId) {
        return {
            tabId,
            ...parseSessionTabId(tabId),
        };
    }
    return {
        tabId: viewKey,
        ...parseSessionTabId(viewKey),
    };
}
function parseTabViewKey(viewKey) {
    return viewKey.startsWith(tabViewKeyPrefix) ? viewKey.slice(tabViewKeyPrefix.length) : undefined;
}
function parseSessionTabId(tabId) {
    if (!tabId.includes(":")) {
        return {};
    }
    const [siteId, ...sessionParts] = tabId.split(":");
    return {
        siteId,
        sessionId: sessionParts.join(":"),
    };
}
