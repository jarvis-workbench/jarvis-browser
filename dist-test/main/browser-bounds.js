"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.clampBrowserBounds = exports.defaultBrowserBounds = void 0;
exports.defaultBrowserBounds = {
    x: 280,
    y: 112,
    width: 980,
    height: 620,
};
const clampBrowserBounds = (rect) => ({
    x: Math.max(0, Math.trunc(rect?.x ?? exports.defaultBrowserBounds.x)),
    y: Math.max(0, Math.trunc(rect?.y ?? exports.defaultBrowserBounds.y)),
    width: Math.max(320, Math.trunc(rect?.width ?? exports.defaultBrowserBounds.width)),
    height: Math.max(240, Math.trunc(rect?.height ?? exports.defaultBrowserBounds.height)),
});
exports.clampBrowserBounds = clampBrowserBounds;
