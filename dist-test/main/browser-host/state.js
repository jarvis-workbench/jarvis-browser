"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.fallbackBrowserState = void 0;
exports.createBrowserState = createBrowserState;
exports.createTabState = createTabState;
const internal_protocol_1 = require("../internal-protocol");
exports.fallbackBrowserState = {
    url: "",
    title: "",
    canGoBack: false,
    canGoForward: false,
    isLoading: false,
};
function createBrowserState(input) {
    const webContents = input.view?.webContents;
    const history = webContents?.navigationHistory;
    const pageUrl = webContents?.getURL() ?? "";
    const currentUrl = input.displayUrl ?? input.patch.url ?? ((0, internal_protocol_1.isInternalErrorPageUrl)(pageUrl) ? "" : pageUrl);
    const title = input.patch.title ?? (input.statusCode ? `HTTP ${input.statusCode}` : webContents?.getTitle()) ?? "";
    return {
        ...exports.fallbackBrowserState,
        ...input.previous,
        ...input.patch,
        url: currentUrl,
        displayUrl: input.displayUrl,
        title,
        canGoBack: Boolean(history?.canGoBack()),
        canGoForward: Boolean(history?.canGoForward()),
        isLoading: Boolean(webContents?.isLoading()),
    };
}
function createTabState(input) {
    return {
        ...createBrowserState(input),
        tabId: input.tabId,
    };
}
