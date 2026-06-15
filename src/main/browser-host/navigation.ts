import { formatError } from "../../shared/utils";

export function isBrowserReloadShortcut(input: Electron.Input) {
  const key = input.key.toLowerCase();
  return input.key === "F5" || (key === "r" && (input.control || input.meta));
}

export function isBrowserDevToolsShortcut(input: Electron.Input) {
  const key = input.key.toLowerCase();
  return input.key === "F12" || (key === "i" && input.shift && (input.control || (input.meta && input.alt)));
}

export function isBrowserCloseTabShortcut(input: Electron.Input) {
  const key = input.key.toLowerCase();
  return input.type === "keyDown" && key === "w" && (input.control || input.meta) && !input.alt && !input.shift;
}

export function formatNavigationError(error: unknown) {
  return formatError(error);
}

export function isNavigationAbort(error: unknown) {
  return formatNavigationError(error).includes("ERR_ABORTED");
}
