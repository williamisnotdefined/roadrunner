import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { type ProjectContext, pathExists } from "./config.js";
import { processIdentityStatus, readProcessInfo } from "./process-info.js";

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

export async function readProcesses(context: ProjectContext): Promise<ProcessRecord[]> {
  if (!(await pathExists(context.paths.processRegistry))) return [];
  try {
    return (JSON.parse(await readFile(context.paths.processRegistry, "utf8")) as ProcessRegistry).processes ?? [];
  } catch {
    return [];
  }
}

export async function registerProcess(record: ProcessRecord, context: ProjectContext): Promise<void> {
  const info = await readProcessInfo(record.pid);
  if (!info) throw new Error(`Cannot register pid ${record.pid}.`);
  const processes = (await readProcesses(context)).filter((processRecord) => processRecord.pid !== record.pid);
  processes.push({ ...record, processGroupId: record.pid, startTimeTicks: info.startTimeTicks, startedAt: new Date().toISOString() });
  await writeProcesses(processes, context);
}

export async function unregisterProcess(pid: number, context: ProjectContext): Promise<void> {
  await writeProcesses(
    (await readProcesses(context)).filter((processRecord) => processRecord.pid !== pid),
    context,
  );
}

export async function cleanupProcesses(context: ProjectContext, { force = false } = {}): Promise<Array<{ pid: number; role: string; signal?: string; status: string }>> {
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
}

async function writeProcesses(processes: ProcessRecord[], context: ProjectContext): Promise<void> {
  await mkdir(path.dirname(context.paths.processRegistry), { recursive: true });
  if (processes.length === 0) {
    await rm(context.paths.processRegistry, { force: true });
    return;
  }
  await writeFile(context.paths.processRegistry, `${JSON.stringify({ processes }, null, 2)}\n`, { mode: 0o600 });
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
  try {
    /* v8 ignore next -- Windows process signaling is covered by platform branching at runtime. */
    process.kill(process.platform === "win32" ? pid : -pid, signal);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    return false;
  }
}

function processGroupExists(pid: number): boolean {
  try {
    /* v8 ignore next -- Windows process signaling is covered by platform branching at runtime. */
    process.kill(process.platform === "win32" ? pid : -pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return false;
    /* v8 ignore start -- EPERM and unexpected group-probe failures depend on OS permissions. */
    if (code === "EPERM") return true;
    throw error;
    /* v8 ignore stop */
  }
}
