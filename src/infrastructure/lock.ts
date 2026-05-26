import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";

import type { ProjectContext } from "./config.js";
import { processIdentityStatus, readProcessInfo } from "./process-info.js";

interface RoadrunnerLock {
  pid: number;
  startedAt: string;
  startTimeTicks?: string;
}

export async function acquireProjectLock(context: ProjectContext, label = "Roadrunner run"): Promise<() => Promise<void>> {
  await mkdir(path.dirname(context.paths.lock), { recursive: true });
  const lock = await currentLock();

  try {
    const handle = await open(context.paths.lock, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(lock, null, 2)}\n`);
    } finally {
      await handle.close();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST" || !(await removeStaleProjectLock(context))) throw new Error(`${label} lock already exists at ${context.paths.lock}.`);
    return acquireProjectLock(context, label);
  }

  let released = false;
  return async () => {
    if (released) return;
    released = true;
    await releaseProjectLock(context, lock);
  };
}

async function currentLock(): Promise<RoadrunnerLock> {
  const info = await readProcessInfo(process.pid);
  const lock: RoadrunnerLock = { pid: process.pid, startedAt: new Date().toISOString() };
  /* v8 ignore next -- start-time identity is unavailable on non-Linux platforms. */
  if (info?.startTimeTicks !== undefined) lock.startTimeTicks = info.startTimeTicks;
  return lock;
}

async function releaseProjectLock(context: ProjectContext, lock: RoadrunnerLock): Promise<void> {
  try {
    const current = JSON.parse(await readFile(context.paths.lock, "utf8")) as Partial<RoadrunnerLock>;
    if (current.pid === lock.pid && current.startedAt === lock.startedAt && current.startTimeTicks === lock.startTimeTicks) await rm(context.paths.lock, { force: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") return;
  }
}

async function removeStaleProjectLock(context: ProjectContext): Promise<boolean> {
  try {
    const value = JSON.parse(await readFile(context.paths.lock, "utf8")) as Partial<RoadrunnerLock>;
    if (typeof value.pid !== "number") return false;

    const status = await processIdentityStatus({ pid: value.pid, startTimeTicks: typeof value.startTimeTicks === "string" ? value.startTimeTicks : undefined });
    if (status !== "missing" && status !== "different") return false;

    return removeLockFileIfUnchanged(context.paths.lock, value);
  } catch {
    return false;
  }
}

async function removeLockFileIfUnchanged(lockPath: string, expected: Partial<RoadrunnerLock>): Promise<boolean> {
  const stalePath = `${lockPath}.stale.${process.pid}.${Date.now()}`;
  try {
    const current = JSON.parse(await readFile(lockPath, "utf8")) as Partial<RoadrunnerLock>;
    if (!sameLock(current, expected)) return false;
    await rename(lockPath, stalePath);
    const moved = JSON.parse(await readFile(stalePath, "utf8")) as Partial<RoadrunnerLock>;
    if (sameLock(moved, expected)) {
      await rm(stalePath, { force: true });
      return true;
    }
    await restoreQuarantinedLock(stalePath, lockPath);
    return false;
  } catch {
    return false;
  }
}

async function restoreQuarantinedLock(stalePath: string, lockPath: string): Promise<void> {
  try {
    await rename(stalePath, lockPath);
  } catch {
    await rm(stalePath, { force: true });
  }
}

function sameLock(left: Partial<RoadrunnerLock>, right: Partial<RoadrunnerLock>): boolean {
  return left.pid === right.pid && left.startedAt === right.startedAt && left.startTimeTicks === right.startTimeTicks;
}
