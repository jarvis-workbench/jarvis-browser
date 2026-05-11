import { BrowserWindow, screen } from "electron";
import { join } from "node:path";
import type { BrowserRect } from "../shared/types";

type OpenToolOverlayInput = {
  key: string;
  anchor: BrowserRect;
  width: number;
  height: number;
  url: string;
  data?: unknown;
  webPreferences?: Electron.BrowserWindowConstructorOptions["webPreferences"];
};

export class BrowserOverlayHost {
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
    parentWindow.on("blur", () => this.closeOverlay());
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

  dismissFromMainWindowMouse(mouse: Electron.MouseInputEvent) {
    if (mouse.type !== "mouseDown" || !this.hasOpenOverlay()) {
      return;
    }

    if (this.activePopup && isPointInsideRect(mouse.x, mouse.y, this.activePopup.anchor)) {
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
      this.activePopup.anchor,
      this.activePopup.width,
      this.activePopup.height,
    ));
  }

  openOverlayWindow(input: {
    key: string;
    anchor: BrowserRect;
    width: number;
    height: number;
    webPreferences: Electron.BrowserWindowConstructorOptions["webPreferences"];
  }): { popupWindow: BrowserWindow; reused: boolean } {
    validateAnchor(input.anchor);
    if (this.activePopup?.key === input.key && this.popupWindow && !this.popupWindow.isDestroyed()) {
      const existingWindow = this.popupWindow;
      existingWindow.setBounds(this.resolveOverlayBounds(input.anchor, input.width, input.height));
      this.activePopup = {
        key: input.key,
        anchor: input.anchor,
        width: input.width,
        height: input.height,
      };
      return { popupWindow: existingWindow, reused: true };
    }

    this.closeOverlay();
    const bounds = this.resolveOverlayBounds(input.anchor, input.width, input.height);
    const popupWindow = new BrowserWindow({
      parent: this.parentWindow,
      modal: false,
      show: false,
      frame: false,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      focusable: false,
      skipTaskbar: true,
      width: input.width,
      height: input.height,
      x: bounds.x,
      y: bounds.y,
      backgroundColor: "#ffffff",
      webPreferences: input.webPreferences,
    });

    this.popupWindow = popupWindow;
    this.activePopup = {
      key: input.key,
      anchor: input.anchor,
      width: input.width,
      height: input.height,
    };

    popupWindow.setMenuBarVisibility(false);
    popupWindow.once("ready-to-show", () => {
      if (!popupWindow.isDestroyed()) {
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

  private resolveOverlayBounds(anchor: BrowserRect, width: number, height: number) {
    validateAnchor(anchor);
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

  private shouldToggleToolOverlay(key: string, anchor: BrowserRect) {
    const activePopup = this.activePopup;
    if (!activePopup) {
      return false;
    }

    return this.isActive(key) && rectsEqual(activePopup.anchor, anchor);
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
