import type { BrowserWindow, WebContentsView } from "electron";
import type { BrowserRect } from "../../shared/types";

export class ViewRegistry {
  private mountedViewKey?: string;

  constructor(
    private readonly window: BrowserWindow,
    private readonly views: Map<string, WebContentsView>,
    private getBounds: () => BrowserRect,
  ) {}

  getMountedViewKey() {
    return this.mountedViewKey;
  }

  setMountedViewKey(viewKey: string | undefined) {
    this.mountedViewKey = viewKey;
  }

  activate(viewKey: string) {
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

  removeChildView(viewKey: string) {
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
    } catch {
      // Electron may already be tearing down child views during app shutdown.
    }

    if (this.mountedViewKey === viewKey) {
      this.mountedViewKey = undefined;
    }
  }
}
