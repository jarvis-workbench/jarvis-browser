import type { WebContentsView } from "electron";
import type { BrowserState, TabState } from "../../shared/types";
import { isInternalErrorPageUrl } from "../internal-protocol";

export const fallbackBrowserState: BrowserState = {
  url: "",
  title: "",
  canGoBack: false,
  canGoForward: false,
  isLoading: false,
};

interface CreateBrowserStateInput {
  previous?: BrowserState;
  view?: WebContentsView;
  displayUrl?: string;
  statusCode?: number;
  patch: Partial<BrowserState>;
}

export function createBrowserState(input: CreateBrowserStateInput) {
  const webContents = input.view?.webContents;
  const history = webContents?.navigationHistory;
  const pageUrl = webContents?.getURL() ?? "";
  const currentUrl = input.displayUrl ?? input.patch.url ?? (isInternalErrorPageUrl(pageUrl) ? "" : pageUrl);
  const title = input.patch.title ?? (input.statusCode ? `HTTP ${input.statusCode}` : webContents?.getTitle()) ?? "";

  return {
    ...fallbackBrowserState,
    ...input.previous,
    ...input.patch,
    url: currentUrl,
    displayUrl: input.displayUrl,
    title,
    canGoBack: Boolean(history?.canGoBack()),
    canGoForward: Boolean(history?.canGoForward()),
    isLoading: Boolean(webContents?.isLoading()),
  } satisfies BrowserState;
}

export function createTabState(input: CreateBrowserStateInput & { tabId: string }) {
  return {
    ...createBrowserState(input),
    tabId: input.tabId,
  } satisfies TabState;
}
