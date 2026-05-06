import { session } from "electron";

export function getElectronSession(siteId: string, sessionId: string) {
  return session.fromPartition(createSessionPartition(siteId, sessionId));
}

export async function flushElectronSession(targetSession: Electron.Session) {
  targetSession.flushStorageData();
  await targetSession.cookies.flushStore();
}

export function createSessionPartition(siteId: string, sessionId: string) {
  return `persist:site-${siteId}-session-${sessionId}`;
}
