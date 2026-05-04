export class ViewLifecycle {
  private readonly cleanups = new Map<string, Array<() => void>>();
  private readonly closingKeys = new Set<string>();

  isClosing(viewKey: string) {
    return this.closingKeys.has(viewKey);
  }

  markOpen(viewKey: string) {
    this.closingKeys.delete(viewKey);
  }

  registerCleanup(viewKey: string, cleanup: () => void) {
    const cleanups = this.cleanups.get(viewKey) ?? [];
    cleanups.push(cleanup);
    this.cleanups.set(viewKey, cleanups);
  }

  cleanup(viewKey: string) {
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
