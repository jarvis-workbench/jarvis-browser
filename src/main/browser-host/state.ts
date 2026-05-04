import type { WebContentsView } from "electron";
import type { BrowserState } from "../../shared/types";
import { isInternalErrorPageUrl } from "../error-page";

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
  const currentUrl = input.displayUrl || (isInternalErrorPageUrl(pageUrl) ? "" : pageUrl);

  return {
    ...fallbackBrowserState,
    ...input.previous,
    ...input.patch,
    url: currentUrl || input.patch.url || "",
    displayUrl: input.displayUrl,
    title: input.displayUrl ? input.statusCode ? `HTTP ${input.statusCode}` : "网页无法打开" : webContents?.getTitle() ?? "",
    canGoBack: Boolean(history?.canGoBack()),
    canGoForward: Boolean(history?.canGoForward()),
    isLoading: Boolean(webContents?.isLoading()),
  } satisfies BrowserState;
}
