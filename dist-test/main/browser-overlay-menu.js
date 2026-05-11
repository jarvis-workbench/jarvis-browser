"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.toolOverlayUrl = void 0;
exports.parseBrowserOverlayAction = parseBrowserOverlayAction;
exports.getToolOverlayHeight = getToolOverlayHeight;
exports.createExtensionMenuItems = createExtensionMenuItems;
exports.createDownloadMenuItems = createDownloadMenuItems;
exports.createAppMenuItems = createAppMenuItems;
const internal_protocol_1 = require("./internal-protocol");
const browserOverlayActions = new Set([
    "extension-popup",
    "extensions",
    "install-site-extension",
    "downloads",
    "settings",
    "history",
    "clear-browsing-data",
    "jarvis-script",
]);
exports.toolOverlayUrl = `${internal_protocol_1.internalPageOrigin}${internal_protocol_1.overlayInternalPageId}`;
function parseBrowserOverlayAction(value) {
    if (!browserOverlayActions.has(value)) {
        throw new Error("未知浮层动作");
    }
    return value;
}
function getToolOverlayHeight(model) {
    const rowCount = Math.max(1, model.items.length);
    return Math.min(480, 82 + rowCount * 44 + (model.emptyText && !model.items.length ? 44 : 0));
}
function createExtensionMenuItems(input) {
    return [
        ...input.extensions.map((extension) => ({
            id: extension.id,
            label: extension.action?.defaultTitle || extension.name,
            detail: extension.name,
            icon: extension.action?.icon || extension.icon,
            action: "extension-popup",
        })),
        {
            id: "extensions",
            label: "扩展程序管理",
            action: "extensions",
        },
        {
            id: "install-site-extension",
            label: "安装到当前站点",
            action: "install-site-extension",
            disabled: !input.canInstallSiteExtension,
        },
    ];
}
function createDownloadMenuItems(downloads) {
    return [
        ...downloads.slice(0, 4).map((download) => ({
            id: download.id,
            label: download.filename,
            detail: downloadStateLabel(download),
            action: "downloads",
        })),
        {
            id: "downloads",
            label: "完整的下载记录",
            action: "downloads",
        },
    ];
}
function createAppMenuItems() {
    return [
        {
            id: "downloads",
            label: "下载记录",
            action: "downloads",
        },
        {
            id: "history",
            label: "历史记录",
            action: "history",
        },
        {
            id: "clear-browsing-data",
            label: "删除浏览数据",
            action: "clear-browsing-data",
        },
        {
            id: "jarvis-script",
            label: "更多工具 / jarvis-script",
            action: "jarvis-script",
        },
        {
            id: "settings",
            label: "设置",
            action: "settings",
        },
    ];
}
function downloadStateLabel(download) {
    if (download.state === "progressing") {
        return download.paused ? "已暂停" : "下载中";
    }
    if (download.state === "completed") {
        return "已完成";
    }
    if (download.state === "cancelled") {
        return "已取消";
    }
    return "已中断";
}
