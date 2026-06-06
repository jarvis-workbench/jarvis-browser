const explicitSchemePattern = /^[a-zA-Z][a-zA-Z\d+.-]*:/;
const hostLikePattern = /^(localhost|(\d{1,3}\.){3}\d{1,3}|[^/?#:]+\.[^/?#]+)(?::\d+)?(?:[/?#]|$)/i;

export function needsHttpsPrefix(value: string): boolean {
  if (hostLikePattern.test(value)) {
    return true;
  }

  if (explicitSchemePattern.test(value)) {
    return false;
  }

  if (value.startsWith("//")) {
    return true;
  }

  return false;
}

export function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createId(): string {
  if (globalThis.crypto?.randomUUID) {
    return globalThis.crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}
