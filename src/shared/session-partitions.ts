export const defaultProfileId = "default";
export const profilePartitionPrefix = "persist:profile-";

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
