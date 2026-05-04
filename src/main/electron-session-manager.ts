import { session } from "electron";
import { mkdir, readdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";

const preparedSessionPaths = new Set<string>();

export async function getElectronSession(sessionPath: string) {
  if (!preparedSessionPaths.has(sessionPath)) {
    await prepareSessionPath(sessionPath);
    preparedSessionPaths.add(sessionPath);
  }

  return session.fromPath(sessionPath);
}

async function prepareSessionPath(sessionPath: string) {
  await mkdir(sessionPath, { recursive: true });
  await resetChromiumCacheDirectories(sessionPath);

  const nestedDataPath = join(sessionPath, "data");
  const nestedEntries = await readDirOrEmpty(nestedDataPath);
  if (nestedEntries.length === 0) {
    await rm(nestedDataPath, { recursive: true, force: true });
    return;
  }

  const rootEntries = (await readdir(sessionPath)).filter((entry) => entry !== "data");
  if (rootEntries.length > 0) {
    return;
  }

  for (const entry of nestedEntries) {
    await rename(join(nestedDataPath, entry), join(sessionPath, entry));
  }
  await rm(nestedDataPath, { recursive: true, force: true });
}

async function resetChromiumCacheDirectories(sessionPath: string) {
  const cacheDirs = [
    join(sessionPath, "Cache"),
    join(sessionPath, "Code Cache"),
    join(sessionPath, "GPUCache"),
    join(sessionPath, "DawnGraphiteCache"),
    join(sessionPath, "DawnWebGPUCache"),
    join(sessionPath, "Shared Dictionary"),
  ];

  for (const cacheDir of cacheDirs) {
    await rm(cacheDir, { recursive: true, force: true });
  }
}

async function readDirOrEmpty(path: string) {
  try {
    return await readdir(path);
  } catch {
    return [];
  }
}
