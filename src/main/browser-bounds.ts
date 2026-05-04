import type { BrowserRect } from "../shared/types";

export const defaultBrowserBounds: BrowserRect = {
  x: 280,
  y: 112,
  width: 980,
  height: 620,
};

export const clampBrowserBounds = (rect?: BrowserRect): BrowserRect => ({
  x: Math.max(0, Math.trunc(rect?.x ?? defaultBrowserBounds.x)),
  y: Math.max(0, Math.trunc(rect?.y ?? defaultBrowserBounds.y)),
  width: Math.max(320, Math.trunc(rect?.width ?? defaultBrowserBounds.width)),
  height: Math.max(240, Math.trunc(rect?.height ?? defaultBrowserBounds.height)),
});
