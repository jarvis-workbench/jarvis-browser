"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ViewRegistry = void 0;
class ViewRegistry {
    window;
    views;
    getBounds;
    mountedViewKey;
    constructor(window, views, getBounds) {
        this.window = window;
        this.views = views;
        this.getBounds = getBounds;
    }
    getMountedViewKey() {
        return this.mountedViewKey;
    }
    setMountedViewKey(viewKey) {
        this.mountedViewKey = viewKey;
    }
    activate(viewKey) {
        const view = this.views.get(viewKey);
        if (!view || view.webContents.isDestroyed()) {
            return;
        }
        if (this.mountedViewKey && this.mountedViewKey !== viewKey) {
            this.removeChildView(this.mountedViewKey);
        }
        if (this.mountedViewKey !== viewKey) {
            this.window.contentView.addChildView(view);
            this.mountedViewKey = viewKey;
        }
        view.setBounds(this.getBounds());
    }
    unmountActiveView() {
        if (this.mountedViewKey) {
            this.removeChildView(this.mountedViewKey);
        }
    }
    removeChildView(viewKey) {
        const view = this.views.get(viewKey);
        if (!view) {
            if (this.mountedViewKey === viewKey) {
                this.mountedViewKey = undefined;
            }
            return;
        }
        try {
            if (!this.window.isDestroyed()) {
                this.window.contentView.removeChildView(view);
            }
        }
        catch {
            // Electron may already be tearing down child views during app shutdown.
        }
        if (this.mountedViewKey === viewKey) {
            this.mountedViewKey = undefined;
        }
    }
}
exports.ViewRegistry = ViewRegistry;
