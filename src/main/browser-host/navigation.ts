import { formatError } from "../../shared/utils";
import type { BrowserTab } from "../../shared/types";

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

export function isBrowserFindShortcut(input: Electron.Input) {
  const key = input.key.toLowerCase();
  const isPlatformModifier = process.platform === "darwin"
    ? input.meta
    : input.control && !input.meta;
  return input.type === "keyDown" && key === "f" && isPlatformModifier && !input.alt && !input.shift;
}

export function formatNavigationError(error: unknown) {
  return formatError(error);
}

export function isNavigationAbort(error: unknown) {
  return formatNavigationError(error).includes("ERR_ABORTED");
}

export function resolveNextActiveTabIdAfterClose(closingTab: BrowserTab, tabs: Iterable<BrowserTab>) {
  const orderedTabs = [...tabs];
  const remainingTabs = orderedTabs.filter((tab) => tab.id !== closingTab.id);
  if (remainingTabs.length === 0) {
    return undefined;
  }

  const sameSessionTabs = closingTab.siteId && closingTab.sessionId
    ? remainingTabs.filter((tab) => tab.siteId === closingTab.siteId && tab.sessionId === closingTab.sessionId)
    : [];
  const sameSiteTabs = closingTab.siteId
    ? remainingTabs.filter((tab) => tab.siteId === closingTab.siteId)
    : [];

  return closestTabIdByOrder(closingTab.id, sameSessionTabs, orderedTabs)
    || closestTabIdByOrder(closingTab.id, sameSiteTabs, orderedTabs)
    || closestTabIdByOrder(closingTab.id, remainingTabs, orderedTabs);
}

function closestTabIdByOrder(originTabId: string, candidates: BrowserTab[], tabs: BrowserTab[]) {
  if (candidates.length === 0) {
    return undefined;
  }

  const tabIds = tabs.map((tab) => tab.id);
  const originIndex = tabIds.indexOf(originTabId);
  const candidateIds = new Set(candidates.map((tab) => tab.id));
  for (let index = originIndex + 1; index < tabIds.length; index += 1) {
    const tabId = tabIds[index];
    if (candidateIds.has(tabId)) {
      return tabId;
    }
  }
  for (let index = originIndex - 1; index >= 0; index -= 1) {
    const tabId = tabIds[index];
    if (candidateIds.has(tabId)) {
      return tabId;
    }
  }

  return candidates.at(-1)?.id;
}
