import { mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { type ProjectContext, pathExists } from "./config.js";
import { processIdentityStatus, readProcessInfo } from "./process-info.js";
import { processTreeExists, signalProcessTree, type ProcessTreeRoot } from "./process-tree.js";

export interface ProcessRecord {
  command: string[];
  cwd: string;
  ownerToken?: string;
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
    const value = JSON.parse(await readFile(context.paths.processRegistry, "utf8")) as Partial<ProcessRegistry> | null;
    return Array.isArray(value?.processes) ? value.processes.filter(isProcessRecord) : [];
  } catch {
    return [];
  }
}

export async function registerProcess(record: ProcessRecord, context: ProjectContext): Promise<ProcessRecord> {
  return withProcessRegistryLock(context, async () => {
    if (!isPositiveSafeInteger(record.pid)) throw new Error(`Cannot register pid ${record.pid}.`);
    const info = await readProcessInfo(record.pid);
    if (!info) throw new Error(`Cannot register pid ${record.pid}.`);
    const processes = (await readProcesses(context)).filter((processRecord) => processRecord.pid !== record.pid);
    const registered = { ...record, processGroupId: info.processGroupId ?? record.pid, startTimeTicks: info.startTimeTicks, startedAt: new Date().toISOString() };
    processes.push(registered);
    await writeProcesses(processes, context);
    return registered;
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

    const root = processTreeRootFromRecord(record);
    if (root !== null && processTreeExists(root)) return false;

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

      const root = processTreeRootFromRecord(record, processGroupId);
      if (root === null) {
        results.push({ pid: record.pid, role: record.role, status: "stale" });
        continue;
      }

      if (!processTreeExists(root)) {
        results.push({ pid: record.pid, role: record.role, status: "stale" });
        continue;
      }

      const signaled = signalProcessTree(root, "SIGTERM");
      results.push({ pid: record.pid, role: record.role, signal: "SIGTERM", status: signaled ? "signaled" : "missing" });
      await sleep(1000);

      if (force && processTreeExists(root)) {
        signalProcessTree(root, "SIGKILL");
        results.push({ pid: record.pid, role: record.role, signal: "SIGKILL", status: "signaled" });
        await sleep(100);
      }

      if (processTreeExists(root)) survivors.push(record);
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
  /* v8 ignore next -- /proc identity can be unavailable during defensive lock creation. */
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
      if (Date.now() >= deadline) throw new Error(`Process registry lock already exists at ${lockPath}. Another Roadrunner cleanup or subprocess registration may still be active. Retry shortly, or remove the stale lock manually only if you are sure no Roadrunner process is using it.`);
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
    if (!isPositiveSafeInteger(value.pid)) return removeLockFileIfUnchanged(lockPath, value);

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

function safeProcessGroupId(record: ProcessRecord): number | null {
  if (!isPositiveSafeInteger(record.pid)) return null;
  if (record.processGroupId === undefined) return record.pid;
  return isPositiveSafeInteger(record.processGroupId) && record.processGroupId === record.pid ? record.processGroupId : null;
}

function processTreeRootFromRecord(record: ProcessRecord, processGroupId = safeProcessGroupId(record)): ProcessTreeRoot | null {
  if (processGroupId === null || typeof record.startTimeTicks !== "string" || record.startTimeTicks.length === 0) return null;
  return { ownerToken: record.ownerToken, pid: record.pid, processGroupId, startTimeTicks: record.startTimeTicks };
}

function isProcessRecord(value: unknown): value is ProcessRecord {
  if (!isRecord(value)) return false;
  if (!Array.isArray(value.command) || !value.command.every((item) => typeof item === "string")) return false;
  if (typeof value.cwd !== "string" || value.cwd.length === 0) return false;
  if (!isOptionalString(value.ownerToken)) return false;
  if (!isPositiveSafeInteger(value.pid)) return false;
  if (value.processGroupId !== undefined && !isPositiveSafeInteger(value.processGroupId)) return false;
  if (typeof value.role !== "string" || value.role.length === 0) return false;
  if (!isOptionalString(value.startTimeTicks)) return false;
  if (!isOptionalString(value.startedAt)) return false;
  return true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || (typeof value === "string" && value.length > 0);
}
