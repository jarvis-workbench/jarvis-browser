import type { BrowserRect, DownloadState, SiteExtension } from "../shared/types";
import { internalPageOrigin, overlayInternalPageId } from "./internal-protocol";

export type BrowserOverlayAction =
  | "extension-popup"
  | "extensions"
  | "install-site-extension"
  | "downloads"
  | "settings"
  | "history"
  | "clear-browsing-data"
  | "jarvis-script";

const browserOverlayActions = new Set<string>([
  "extension-popup",
  "extensions",
  "install-site-extension",
  "downloads",
  "settings",
  "history",
  "clear-browsing-data",
  "jarvis-script",
]);

export type BrowserOverlayMenuItem = {
  id: string;
  label: string;
  detail?: string;
  icon?: string;
  action: BrowserOverlayAction;
  disabled?: boolean;
};

export type BrowserOverlayMenuModel = {
  title: string;
  subtitle?: string;
  anchor: BrowserRect;
  items: BrowserOverlayMenuItem[];
  emptyText?: string;
};

export const toolOverlayUrl = `${internalPageOrigin}${overlayInternalPageId}`;

export function parseBrowserOverlayAction(value: string): BrowserOverlayAction {
  if (!browserOverlayActions.has(value)) {
    throw new Error("未知浮层动作");
  }

  return value as BrowserOverlayAction;
}

export function getToolOverlayHeight(model: BrowserOverlayMenuModel) {
  const rowCount = Math.max(1, model.items.length);
  return Math.min(480, 82 + rowCount * 44 + (model.emptyText && !model.items.length ? 44 : 0));
}

export function createExtensionMenuItems(input: {
  extensions: SiteExtension[];
  canInstallSiteExtension: boolean;
}) {
  return [
    ...input.extensions.map((extension) => ({
      id: extension.id,
      label: extension.action?.defaultTitle || extension.name,
      detail: extension.name,
      icon: extension.action?.icon || extension.icon,
      action: "extension-popup" as const,
    })),
    {
      id: "extensions",
      label: "扩展程序管理",
      action: "extensions" as const,
    },
    {
      id: "install-site-extension",
      label: "安装到当前站点",
      action: "install-site-extension" as const,
      disabled: !input.canInstallSiteExtension,
    },
  ];
}

export function createDownloadMenuItems(downloads: DownloadState[]) {
  return [
    ...downloads.slice(0, 4).map((download) => ({
      id: download.id,
      label: download.filename,
      detail: downloadStateLabel(download),
      action: "downloads" as const,
    })),
    {
      id: "downloads",
      label: "完整的下载记录",
      action: "downloads" as const,
    },
  ];
}

export function createAppMenuItems() {
  return [
    {
      id: "downloads",
      label: "下载记录",
      action: "downloads" as const,
    },
    {
      id: "history",
      label: "历史记录",
      action: "history" as const,
    },
    {
      id: "clear-browsing-data",
      label: "删除浏览数据",
      action: "clear-browsing-data" as const,
    },
    {
      id: "jarvis-script",
      label: "更多工具 / jarvis-script",
      action: "jarvis-script" as const,
    },
    {
      id: "settings",
      label: "设置",
      action: "settings" as const,
    },
  ];
}

function downloadStateLabel(download: DownloadState) {
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
