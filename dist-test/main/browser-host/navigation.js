"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.isBrowserReloadShortcut = isBrowserReloadShortcut;
exports.isBrowserDevToolsShortcut = isBrowserDevToolsShortcut;
exports.formatNavigationError = formatNavigationError;
exports.isNavigationAbort = isNavigationAbort;
function isBrowserReloadShortcut(input) {
    const key = input.key.toLowerCase();
    return input.key === "F5" || (key === "r" && (input.control || input.meta));
}
function isBrowserDevToolsShortcut(input) {
    const key = input.key.toLowerCase();
    return input.key === "F12" || (key === "i" && input.shift && (input.control || (input.meta && input.alt)));
}
function formatNavigationError(error) {
    return error instanceof Error ? error.message : String(error);
}
function isNavigationAbort(error) {
    return formatNavigationError(error).includes("ERR_ABORTED");
}
