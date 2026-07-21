import { BrowserWindow, screen } from "electron";
import { join } from "node:path";
import type { BrowserRect } from "../shared/types";
import { registerInternalProtocolForSession } from "./internal-protocol";

type OpenToolOverlayInput = {
  key: string;
  anchor: BrowserRect;
  width: number;
  height: number;
  url: string;
  data?: unknown;
  webPreferences?: Electron.BrowserWindowConstructorOptions["webPreferences"];
};

const overlayShadowInset = 12;

export class BrowserOverlayHost {
  private popupWindow?: BrowserWindow;
  private activePopup?: {
    key: string;
    anchor: BrowserRect;
    anchorXMode: "left" | "right";
    anchorRightOffset: number;
    width: number;
    height: number;
    shadowInset: number;
    focusable: boolean;
  };

  constructor(private readonly parentWindow: BrowserWindow) {
    parentWindow.on("move", () => this.repositionActivePopup());
    parentWindow.on("resize", () => this.repositionActivePopup());
    parentWindow.on("blur", () => this.handleParentBlur());
    parentWindow.on("minimize", () => this.closeOverlay());
    parentWindow.on("hide", () => this.closeOverlay());
    parentWindow.on("closed", () => this.closeOverlay());
    parentWindow.webContents.on("before-mouse-event", (_event, mouse) => this.dismissFromMainWindowMouse(mouse));
    parentWindow.webContents.on("before-input-event", (event, input) => {
      if (this.dismissFromKeyboard(input)) {
        event.preventDefault();
      }
    });
  }

  async openToolOverlay(input: OpenToolOverlayInput) {
    if (this.shouldToggleToolOverlay(input.key, input.anchor)) {
      this.closeOverlay();
      return;
    }

    const openResult = this.openOverlayWindow({
      key: input.key,
      anchor: input.anchor,
      width: input.width,
      height: input.height,
      webPreferences: input.webPreferences ?? {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        preload: join(__dirname, "../preload/overlay-preload.js"),
      },
    });
    const { popupWindow } = openResult;

    if (input.data !== undefined) {
      const sendOverlayData = () => {
        if (!popupWindow.isDestroyed() && !popupWindow.webContents.isDestroyed()) {
          popupWindow.webContents.send("overlay:data", input.data);
        }
      };
      if (openResult.reused && popupWindow.webContents.getURL() === input.url) {
        sendOverlayData();
        return;
      } else {
        popupWindow.webContents.once("did-finish-load", sendOverlayData);
      }
    }
    await popupWindow.loadURL(input.url);
  }

  closeOverlay() {
    const popupWindow = this.popupWindow;
    this.popupWindow = undefined;
    this.activePopup = undefined;
    if (popupWindow && !popupWindow.isDestroyed()) {
      popupWindow.destroy();
    }
  }

  isActive(key: string) {
    return this.activePopup?.key === key && Boolean(this.popupWindow && !this.popupWindow.isDestroyed());
  }

  resizeActiveOverlay(key: string, input: { width: number; height: number; anchor?: BrowserRect }) {
    if (!this.isActive(key) || !this.popupWindow || this.popupWindow.isDestroyed() || !this.activePopup) {
      return false;
    }

    const anchor = input.anchor ?? this.resolveActiveAnchor(this.activePopup);
    const width = Math.max(1, Math.round(input.width));
    const height = Math.max(1, Math.round(input.height));
    const shadowInset = this.activePopup.shadowInset;
    const focusable = this.activePopup.focusable;
    this.activePopup = this.createActivePopup(key, anchor, width, height, shadowInset, focusable);
    this.popupWindow.setBounds(this.resolveOverlayBounds(anchor, width, height, shadowInset));
    return true;
  }

  dismissFromMainWindowMouse(mouse: Electron.MouseInputEvent) {
    if (mouse.type !== "mouseDown" || !this.hasOpenOverlay()) {
      return;
    }

    if (this.activePopup && isPointInsideRect(mouse.x, mouse.y, this.resolveActiveAnchor(this.activePopup))) {
      return;
    }

    this.closeOverlay();
  }

  dismissFromPageInteraction() {
    if (this.hasOpenOverlay()) {
      this.closeOverlay();
    }
  }

  dismissFromKeyboard(input: Electron.Input) {
    if (input.type !== "keyDown" || input.key !== "Escape" || !this.hasOpenOverlay()) {
      return false;
    }

    this.closeOverlay();
    return true;
  }

  private repositionActivePopup() {
    if (!this.popupWindow || this.popupWindow.isDestroyed() || !this.activePopup) {
      return;
    }

    this.popupWindow.setBounds(this.resolveOverlayBounds(
      this.resolveActiveAnchor(this.activePopup),
      this.activePopup.width,
      this.activePopup.height,
      this.activePopup.shadowInset,
    ));
  }

  openOverlayWindow(input: {
    key: string;
    anchor: BrowserRect;
    width: number;
    height: number;
    shadowInset?: number;
    focusable?: boolean;
    webPreferences: Electron.BrowserWindowConstructorOptions["webPreferences"];
  }): { popupWindow: BrowserWindow; reused: boolean } {
    validateAnchor(input.anchor);
    const shadowInset = input.shadowInset === undefined ? overlayShadowInset : Math.max(0, Math.round(input.shadowInset));
    const focusable = Boolean(input.focusable);
    if (this.activePopup?.key === input.key && this.popupWindow && !this.popupWindow.isDestroyed()) {
      const existingWindow = this.popupWindow;
      const nextPopup = this.createActivePopup(input.key, input.anchor, input.width, input.height, shadowInset, focusable);
      existingWindow.setBounds(this.resolveOverlayBounds(input.anchor, input.width, input.height, shadowInset));
      this.activePopup = {
        ...nextPopup,
      };
      if (focusable && !existingWindow.isDestroyed()) {
        existingWindow.focus();
      }
      return { popupWindow: existingWindow, reused: true };
    }

    this.closeOverlay();
    const bounds = this.resolveOverlayBounds(input.anchor, input.width, input.height, shadowInset);
    const popupWindow = new BrowserWindow({
      parent: this.parentWindow,
      modal: false,
      show: false,
      frame: false,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      focusable,
      skipTaskbar: true,
      transparent: true,
      hasShadow: false,
      width: bounds.width,
      height: bounds.height,
      x: bounds.x,
      y: bounds.y,
      backgroundColor: "#00000000",
      webPreferences: input.webPreferences,
    });

    this.popupWindow = popupWindow;
    this.activePopup = this.createActivePopup(input.key, input.anchor, input.width, input.height, shadowInset, focusable);
    registerInternalProtocolForSession(popupWindow.webContents.session);

    if (focusable) {
      popupWindow.on("blur", () => {
        // Close only when focus leaves both parent and popup.
        setTimeout(() => {
          if (!this.popupWindow || this.popupWindow.isDestroyed() || this.popupWindow !== popupWindow) {
            return;
          }
          if (popupWindow.isFocused() || popupWindow.webContents.isFocused() || this.parentWindow.isFocused()) {
            return;
          }
          this.closeOverlay();
        }, 0);
      });
    }

    popupWindow.setMenuBarVisibility(false);
    popupWindow.once("ready-to-show", () => {
      if (popupWindow.isDestroyed()) {
        return;
      }
      if (focusable) {
        popupWindow.show();
        popupWindow.focus();
      } else {
        popupWindow.showInactive();
      }
    });
    popupWindow.on("closed", () => {
      if (this.popupWindow === popupWindow) {
        this.popupWindow = undefined;
        this.activePopup = undefined;
      }
    });

    return { popupWindow, reused: false };
  }

  private createActivePopup(
    key: string,
    anchor: BrowserRect,
    width: number,
    height: number,
    shadowInset = overlayShadowInset,
    focusable = false,
  ) {
    const contentBounds = this.parentWindow.getContentBounds();
    return {
      key,
      anchor,
      anchorXMode: anchor.x + anchor.width / 2 > contentBounds.width / 2 ? "right" as const : "left" as const,
      anchorRightOffset: Math.max(0, contentBounds.width - anchor.x - anchor.width),
      width,
      height,
      shadowInset,
      focusable,
    };
  }

  private handleParentBlur() {
    // Focusable extension popups intentionally take focus for text input.
    // Closing on parent blur would immediately dismiss them.
    if (this.activePopup?.focusable && this.popupWindow && !this.popupWindow.isDestroyed()) {
      if (this.popupWindow.isFocused() || this.popupWindow.webContents.isFocused()) {
        return;
      }
      // Give focus transfer a tick before deciding.
      setTimeout(() => {
        if (!this.activePopup?.focusable || !this.popupWindow || this.popupWindow.isDestroyed()) {
          return;
        }
        if (this.popupWindow.isFocused() || this.popupWindow.webContents.isFocused()) {
          return;
        }
        // If neither parent nor popup is focused, user switched away.
        if (!this.parentWindow.isFocused()) {
          this.closeOverlay();
        }
      }, 0);
      return;
    }
    this.closeOverlay();
  }

  private resolveActiveAnchor(activePopup: NonNullable<BrowserOverlayHost["activePopup"]>) {
    if (activePopup.anchorXMode === "left") {
      return activePopup.anchor;
    }

    const contentBounds = this.parentWindow.getContentBounds();
    return {
      ...activePopup.anchor,
      x: Math.max(0, contentBounds.width - activePopup.anchorRightOffset - activePopup.anchor.width),
    };
  }

  private resolveOverlayBounds(anchor: BrowserRect, width: number, height: number, shadowInset = overlayShadowInset) {
    validateAnchor(anchor);
    const gap = 8;
    const outerWidth = width + shadowInset * 2;
    const outerHeight = height + shadowInset * 2;
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
      x: clamp(preferredX - shadowInset, workArea.x, workArea.x + workArea.width - outerWidth),
      y: clamp(y - shadowInset, workArea.y, workArea.y + workArea.height - outerHeight),
      width: outerWidth,
      height: outerHeight,
    };
  }

  private shouldToggleToolOverlay(key: string, anchor: BrowserRect) {
    const activePopup = this.activePopup;
    if (!activePopup) {
      return false;
    }

    return this.isActive(key) && rectsEqual(this.resolveActiveAnchor(activePopup), anchor);
  }

  private hasOpenOverlay() {
    return Boolean(this.popupWindow && !this.popupWindow.isDestroyed());
  }
}

function validateAnchor(anchor: BrowserRect) {
  if (!Number.isFinite(anchor.x)
    || !Number.isFinite(anchor.y)
    || !Number.isFinite(anchor.width)
    || !Number.isFinite(anchor.height)
    || anchor.width <= 0
    || anchor.height <= 0) {
    throw new Error("浮层锚点无效");
  }
}

function clamp(value: number, min: number, max: number) {
  if (max < min) {
    return min;
  }

  return Math.max(min, Math.min(max, Math.round(value)));
}

function rectsEqual(left: BrowserRect, right: BrowserRect) {
  return left.x === right.x
    && left.y === right.y
    && left.width === right.width
    && left.height === right.height;
}

function isPointInsideRect(x: number, y: number, rect: BrowserRect) {
  return x >= rect.x
    && x <= rect.x + rect.width
    && y >= rect.y
    && y <= rect.y + rect.height;
}
