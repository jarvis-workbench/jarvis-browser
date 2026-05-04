export function createViewKey(siteId: string, sessionId: string) {
  return `${siteId}:${sessionId}`;
}

export function parseViewKey(viewKey: string) {
  const [siteId, ...sessionParts] = viewKey.split(":");
  return {
    siteId,
    sessionId: sessionParts.join(":"),
  };
}
