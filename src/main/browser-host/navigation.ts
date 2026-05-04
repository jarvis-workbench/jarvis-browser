export function isBrowserReloadShortcut(input: Electron.Input) {
  const key = input.key.toLowerCase();
  return input.key === "F5" || (key === "r" && (input.control || input.meta));
}

export function isBrowserDevToolsShortcut(input: Electron.Input) {
  const key = input.key.toLowerCase();
  return input.key === "F12" || (key === "i" && input.shift && (input.control || (input.meta && input.alt)));
}

export function formatNavigationError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export function isNavigationAbort(error: unknown) {
  return formatNavigationError(error).includes("ERR_ABORTED");
}
