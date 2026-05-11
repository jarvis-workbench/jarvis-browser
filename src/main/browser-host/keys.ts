export interface ViewKeyParts {
  tabId: string;
  siteId?: string;
  sessionId?: string;
}

export interface SessionViewKeyParts extends ViewKeyParts {
  siteId: string;
  sessionId: string;
}

const tabViewKeyPrefix = "tab:";

export function createViewKey(siteId: string, sessionId: string) {
  return createSessionTabId(siteId, sessionId);
}

export function createSessionTabId(siteId: string, sessionId: string) {
  return `${siteId}:${sessionId}`;
}

export function createTabViewKey(tabId: string) {
  return `${tabViewKeyPrefix}${tabId}`;
}

export function parseViewKey(viewKey: string): SessionViewKeyParts {
  const parts = parseTabViewKeyParts(viewKey);
  if (!parts.siteId || parts.sessionId === undefined) {
    throw new Error(`View key is not a session tab: ${viewKey}`);
  }

  return {
    tabId: parts.tabId,
    siteId: parts.siteId,
    sessionId: parts.sessionId,
  };
}

export function parseTabViewKeyParts(viewKey: string): ViewKeyParts {
  const tabId = parseTabViewKey(viewKey);
  if (tabId) {
    return {
      tabId,
      ...parseSessionTabId(tabId),
    };
  }

  return {
    tabId: viewKey,
    ...parseSessionTabId(viewKey),
  };
}

export function parseTabViewKey(viewKey: string) {
  return viewKey.startsWith(tabViewKeyPrefix) ? viewKey.slice(tabViewKeyPrefix.length) : undefined;
}

export function parseSessionTabId(tabId: string) {
  if (!tabId.includes(":")) {
    return {};
  }

  const [siteId, ...sessionParts] = tabId.split(":");
  return {
    siteId,
    sessionId: sessionParts.join(":"),
  };
}
