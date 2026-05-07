import { BrowserWindow, screen } from "electron";
import { join } from "node:path";
import type { BrowserRect, SiteExtension } from "../shared/types";
import { getElectronSession } from "./electron-session-manager";

type PopupKind = "extension-action";

type OpenExtensionPopupInput = {
  kind?: PopupKind;
  siteId: string;
  sessionId: string;
  extension: SiteExtension;
  anchor: BrowserRect;
  targetTab: {
    id: number;
    url: string;
    title?: string;
  };
};

const defaultPopupSize = {
  width: 360,
  height: 520,
};

export class PopupWindowManager {
  private popupWindow?: BrowserWindow;
  private activePopup?: {
    key: string;
    anchor: BrowserRect;
    width: number;
    height: number;
  };

  constructor(private readonly parentWindow: BrowserWindow) {
    parentWindow.on("move", () => this.repositionActivePopup());
    parentWindow.on("resize", () => this.repositionActivePopup());
    parentWindow.on("minimize", () => this.closePopup());
    parentWindow.on("hide", () => this.closePopup());
    parentWindow.on("closed", () => this.closePopup());
  }

  async openExtensionPopup(input: OpenExtensionPopupInput) {
    const defaultPopup = input.extension.action?.defaultPopup?.trim();
    if (!defaultPopup) {
      throw new Error("插件未声明 popup 面板");
    }

    const targetSession = getElectronSession(input.siteId, input.sessionId);
    const loadedExtension = targetSession.getAllExtensions()
      .find((extension) => extension.id === input.extension.id || extension.path === input.extension.path);
    if (!loadedExtension) {
      throw new Error("插件尚未加载到当前会话");
    }

    const key = `${input.kind ?? "extension-action"}:${input.siteId}:${input.sessionId}:${loadedExtension.id}:${defaultPopup}`;
    if (this.activePopup?.key === key && this.popupWindow && !this.popupWindow.isDestroyed()) {
      this.closePopup();
      return;
    }

    this.closePopup();
    const width = defaultPopupSize.width;
    const height = defaultPopupSize.height;
    const bounds = this.resolvePopupBounds(input.anchor, width, height);
    const popupWindow = new BrowserWindow({
      parent: this.parentWindow,
      modal: false,
      show: false,
      frame: false,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      width,
      height,
      x: bounds.x,
      y: bounds.y,
      backgroundColor: "#ffffff",
      webPreferences: {
        session: targetSession,
        preload: join(__dirname, "../preload/extension-popup-preload.js"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });

    this.popupWindow = popupWindow;
    this.activePopup = {
      key,
      anchor: input.anchor,
      width,
      height,
    };

    popupWindow.setMenuBarVisibility(false);
    popupWindow.once("ready-to-show", () => {
      if (!popupWindow.isDestroyed()) {
        popupWindow.show();
      }
    });
    popupWindow.on("blur", () => this.closePopup());
    popupWindow.on("closed", () => {
      if (this.popupWindow === popupWindow) {
        this.popupWindow = undefined;
        this.activePopup = undefined;
      }
    });

    try {
      const popupUrl = new URL(defaultPopup, loadedExtension.url);
      popupUrl.searchParams.set("jarvisTabId", String(input.targetTab.id));
      popupUrl.searchParams.set("jarvisTabUrl", input.targetTab.url);
      if (input.targetTab.title) {
        popupUrl.searchParams.set("jarvisTabTitle", input.targetTab.title);
      }
      await popupWindow.loadURL(popupUrl.toString());
    } catch (error) {
      this.closePopup();
      throw error;
    }
  }

  closePopup() {
    const popupWindow = this.popupWindow;
    this.popupWindow = undefined;
    this.activePopup = undefined;
    if (popupWindow && !popupWindow.isDestroyed()) {
      popupWindow.destroy();
    }
  }

  private repositionActivePopup() {
    if (!this.popupWindow || this.popupWindow.isDestroyed() || !this.activePopup) {
      return;
    }

    this.popupWindow.setBounds(this.resolvePopupBounds(
      this.activePopup.anchor,
      this.activePopup.width,
      this.activePopup.height,
    ));
  }

  private resolvePopupBounds(anchor: BrowserRect, width: number, height: number) {
    const gap = 8;
    const contentBounds = this.parentWindow.getContentBounds();
    const preferredX = contentBounds.x + anchor.x + anchor.width - width;
    const preferredY = contentBounds.y + anchor.y + anchor.height + gap;
    const fallbackY = contentBounds.y + anchor.y - height - gap;
    const display = screen.getDisplayMatching({
      x: contentBounds.x + anchor.x,
      y: contentBounds.y + anchor.y,
      width: Math.max(1, anchor.width),
      height: Math.max(1, anchor.height),
    });
    const workArea = display.workArea;
    const y = preferredY + height > workArea.y + workArea.height && fallbackY >= workArea.y
      ? fallbackY
      : preferredY;

    return {
      x: clamp(preferredX, workArea.x, workArea.x + workArea.width - width),
      y: clamp(y, workArea.y, workArea.y + workArea.height - height),
      width,
      height,
    };
  }
}

function clamp(value: number, min: number, max: number) {
  if (max < min) {
    return min;
  }

  return Math.max(min, Math.min(max, Math.round(value)));
}
