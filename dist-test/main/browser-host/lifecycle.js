"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ViewLifecycle = void 0;
class ViewLifecycle {
    cleanups = new Map();
    closingKeys = new Set();
    isClosing(viewKey) {
        return this.closingKeys.has(viewKey);
    }
    markOpen(viewKey) {
        this.closingKeys.delete(viewKey);
    }
    registerCleanup(viewKey, cleanup) {
        const cleanups = this.cleanups.get(viewKey) ?? [];
        cleanups.push(cleanup);
        this.cleanups.set(viewKey, cleanups);
    }
    cleanup(viewKey) {
        this.closingKeys.add(viewKey);
        const cleanups = this.cleanups.get(viewKey) ?? [];
        this.cleanups.delete(viewKey);
        for (const cleanup of cleanups) {
            cleanup();
        }
    }
    clear() {
        this.cleanups.clear();
        this.closingKeys.clear();
    }
}
exports.ViewLifecycle = ViewLifecycle;
