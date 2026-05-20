import { session } from "electron";
import { join } from "node:path";
import { dataPaths } from "./data-paths";

export const defaultProfileId = "default";
export const profilePartitionPrefix = "persist:profile-";

export function getElectronSession(siteId: string, sessionId: string) {
  return session.fromPartition(createSessionPartition(siteId, sessionId));
}

export function getDefaultProfileSession() {
  return session.fromPartition(createDefaultProfilePartition());
}

export async function flushElectronSession(targetSession: Electron.Session) {
  targetSession.flushStorageData();
  await targetSession.cookies.flushStore();
}

export function createDefaultProfilePartition() {
  return createProfilePartition(defaultProfileId);
}

export function createProfilePartition(profileId: string) {
  return `${profilePartitionPrefix}${profileId}`;
}

export function createSessionPartition(siteId: string, sessionId: string) {
  return `persist:site-${siteId}-session-${sessionId}`;
}

export function partitionNameFromPartition(partition: string) {
  return partition.replace(/^persist:/, "");
}

export function getSessionPartitionDataPath(siteId: string, sessionId: string) {
  return join(
    dataPaths.runtime.sessionData,
    "Partitions",
    partitionNameFromPartition(createSessionPartition(siteId, sessionId)),
  );
}
