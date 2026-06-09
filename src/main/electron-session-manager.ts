import { session } from "electron";
import { join } from "node:path";
export {
  createDefaultProfilePartition,
  createProfilePartition,
  createSessionPartition,
  defaultProfileId,
  partitionNameFromPartition,
  profilePartitionPrefix,
} from "../shared/session-partitions";
import {
  createDefaultProfilePartition,
  createSessionPartition,
  partitionNameFromPartition,
} from "../shared/session-partitions";
import { dataPaths } from "./data-paths";

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

export function getSessionPartitionDataPath(siteId: string, sessionId: string) {
  return join(
    dataPaths.runtime.sessionData,
    "Partitions",
    partitionNameFromPartition(createSessionPartition(siteId, sessionId)),
  );
}
