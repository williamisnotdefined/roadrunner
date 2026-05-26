import { mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { type ProjectContext, pathExists } from "./config.js";
import { processIdentityStatus, readProcessInfo } from "./process-info.js";
import { processTreeExists, signalProcessTree } from "./process-tree.js";

export interface ProcessRecord {
  command: string[];
  cwd: string;
  pid: number;
  processGroupId?: number;
  role: string;
  startTimeTicks?: string;
  startedAt?: string;
}

interface ProcessRegistry {
  processes: ProcessRecord[];
}

interface ProcessRegistryLock {
  pid: number;
  startedAt: string;
  startTimeTicks?: string;
}

const registryLockRetryMs = 20;
const registryLockTimeoutMs = 5_000;

export async function readProcesses(context: ProjectContext): Promise<ProcessRecord[]> {
  if (!(await pathExists(context.paths.processRegistry))) return [];
  try {
    return (JSON.parse(await readFile(context.paths.processRegistry, "utf8")) as ProcessRegistry).processes ?? [];
  } catch {
    return [];
  }
}

export async function registerProcess(record: ProcessRecord, context: ProjectContext): Promise<void> {
  await withProcessRegistryLock(context, async () => {
    const info = await readProcessInfo(record.pid);
    if (!info) throw new Error(`Cannot register pid ${record.pid}.`);
    const processes = (await readProcesses(context)).filter((processRecord) => processRecord.pid !== record.pid);
    processes.push({ ...record, processGroupId: record.pid, startTimeTicks: info.startTimeTicks, startedAt: new Date().toISOString() });
    await writeProcesses(processes, context);
  });
}

export async function unregisterProcess(pid: number, context: ProjectContext): Promise<void> {
  await withProcessRegistryLock(context, async () => {
    await writeProcesses(
      (await readProcesses(context)).filter((processRecord) => processRecord.pid !== pid),
      context,
    );
  });
}

export async function unregisterProcessIfProcessGroupExited(pid: number, context: ProjectContext): Promise<boolean> {
  return withProcessRegistryLock(context, async () => {
    const processes = await readProcesses(context);
    const record = processes.find((processRecord) => processRecord.pid === pid);
    if (!record) return true;

    const processGroupId = safeProcessGroupId(record);
    if (processGroupId !== null && processGroupExists(processGroupId)) return false;

    await writeProcesses(
      processes.filter((processRecord) => processRecord.pid !== pid),
      context,
    );
    return true;
  });
}

export async function cleanupProcesses(context: ProjectContext, { force = false } = {}): Promise<Array<{ pid: number; role: string; signal?: string; status: string }>> {
  return withProcessRegistryLock(context, async () => {
    const survivors: ProcessRecord[] = [];
    const results: Array<{ pid: number; role: string; signal?: string; status: string }> = [];

    for (const record of await readProcesses(context)) {
      if (path.resolve(record.cwd) !== context.root) {
        results.push({ pid: record.pid, role: record.role, status: "invalid-cwd" });
        continue;
      }

      const processGroupId = safeProcessGroupId(record);
      if (processGroupId === null) {
        results.push({ pid: record.pid, role: record.role, status: "invalid-process-group" });
        continue;
      }

      const signalable = await signalableProcessGroup(record, processGroupId);
      if (!signalable.ok) {
        results.push({ pid: record.pid, role: record.role, status: signalable.status });
        continue;
      }

      const signaled = signalProcessGroup(processGroupId, "SIGTERM");
      results.push({ pid: record.pid, role: record.role, signal: "SIGTERM", status: signaled ? "signaled" : "missing" });
      await sleep(1000);

      if (force && (await signalableProcessGroup(record, processGroupId)).ok) {
        signalProcessGroup(processGroupId, "SIGKILL");
        results.push({ pid: record.pid, role: record.role, signal: "SIGKILL", status: "signaled" });
        await sleep(100);
      }

      if ((await signalableProcessGroup(record, processGroupId)).ok) survivors.push(record);
    }

    await writeProcesses(survivors, context);
    return results;
  });
}

async function writeProcesses(processes: ProcessRecord[], context: ProjectContext): Promise<void> {
  await mkdir(path.dirname(context.paths.processRegistry), { recursive: true });
  if (processes.length === 0) {
    await rm(context.paths.processRegistry, { force: true });
    return;
  }
  const tempPath = `${context.paths.processRegistry}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tempPath, `${JSON.stringify({ processes }, null, 2)}\n`, { mode: 0o600 });
  await rename(tempPath, context.paths.processRegistry);
}

async function withProcessRegistryLock<T>(context: ProjectContext, operation: () => Promise<T>): Promise<T> {
  const lock = await currentProcessRegistryLock();
  const lockPath = registryLockPath(context);
  const release = await acquireProcessRegistryLock(lockPath, lock);
  try {
    return await operation();
  } finally {
    await release();
  }
}

async function currentProcessRegistryLock(): Promise<ProcessRegistryLock> {
  const info = await readProcessInfo(process.pid);
  const lock: ProcessRegistryLock = { pid: process.pid, startedAt: new Date().toISOString() };
  /* v8 ignore next -- start-time identity is unavailable on non-Linux platforms. */
  if (info?.startTimeTicks !== undefined) lock.startTimeTicks = info.startTimeTicks;
  return lock;
}

async function acquireProcessRegistryLock(lockPath: string, lock: ProcessRegistryLock): Promise<() => Promise<void>> {
  await mkdir(path.dirname(lockPath), { recursive: true });
  const deadline = Date.now() + registryLockTimeoutMs;

  while (true) {
    try {
      const handle = await open(lockPath, "wx", 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(lock, null, 2)}\n`);
      } finally {
        await handle.close();
      }
      return () => releaseProcessRegistryLock(lockPath, lock);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (await removeStaleProcessRegistryLock(lockPath)) continue;
      if (Date.now() >= deadline) throw new Error(`Process registry lock already exists at ${lockPath}.`);
      await sleep(registryLockRetryMs);
    }
  }
}

async function releaseProcessRegistryLock(lockPath: string, lock: ProcessRegistryLock): Promise<void> {
  try {
    const current = JSON.parse(await readFile(lockPath, "utf8")) as Partial<ProcessRegistryLock>;
    if (current.pid === lock.pid && current.startedAt === lock.startedAt && current.startTimeTicks === lock.startTimeTicks) await rm(lockPath, { force: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") return;
  }
}

async function removeStaleProcessRegistryLock(lockPath: string): Promise<boolean> {
  try {
    const value = JSON.parse(await readFile(lockPath, "utf8")) as Partial<ProcessRegistryLock>;
    if (typeof value.pid !== "number") return false;

    const status = await processIdentityStatus({ pid: value.pid, startTimeTicks: typeof value.startTimeTicks === "string" ? value.startTimeTicks : undefined });
    if (status !== "missing" && status !== "different") return false;

    return removeLockFileIfUnchanged(lockPath, value);
  } catch {
    return false;
  }
}

async function removeLockFileIfUnchanged(lockPath: string, expected: Partial<ProcessRegistryLock>): Promise<boolean> {
  const stalePath = `${lockPath}.stale.${process.pid}.${Date.now()}`;
  try {
    const current = JSON.parse(await readFile(lockPath, "utf8")) as Partial<ProcessRegistryLock>;
    if (!sameProcessRegistryLock(current, expected)) return false;
    await rename(lockPath, stalePath);
    const moved = JSON.parse(await readFile(stalePath, "utf8")) as Partial<ProcessRegistryLock>;
    if (sameProcessRegistryLock(moved, expected)) {
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

function sameProcessRegistryLock(left: Partial<ProcessRegistryLock>, right: Partial<ProcessRegistryLock>): boolean {
  return left.pid === right.pid && left.startedAt === right.startedAt && left.startTimeTicks === right.startTimeTicks;
}

function registryLockPath(context: ProjectContext): string {
  return `${context.paths.processRegistry}.lock`;
}

async function signalableProcessGroup(record: ProcessRecord, processGroupId: number): Promise<{ ok: true } | { ok: false; status: string }> {
  const status = await processIdentityStatus(record);
  if (status === "same") return { ok: true };
  if (status === "missing" && record.startTimeTicks !== undefined && processGroupExists(processGroupId)) return { ok: true };
  return { ok: false, status: "stale" };
}

function safeProcessGroupId(record: ProcessRecord): number | null {
  if (record.processGroupId === undefined) return record.pid;
  return record.processGroupId === record.pid ? record.processGroupId : null;
}

function signalProcessGroup(pid: number, signal: NodeJS.Signals): boolean {
  return signalProcessTree(pid, signal);
}

function processGroupExists(pid: number): boolean {
  return processTreeExists(pid);
}
