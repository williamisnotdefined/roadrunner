import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { type ProjectContext, pathExists } from "./config.js";

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
    if (!(await isSameProcess(record))) {
      results.push({ pid: record.pid, role: record.role, status: "stale" });
      continue;
    }

    const processGroupId = safeProcessGroupId(record);
    if (processGroupId === null) {
      results.push({ pid: record.pid, role: record.role, status: "invalid-process-group" });
      continue;
    }

    const signaled = signalProcessGroup(processGroupId, "SIGTERM");
    results.push({ pid: record.pid, role: record.role, signal: "SIGTERM", status: signaled ? "signaled" : "missing" });
    await sleep(1000);

    if (force && (await isSameProcess(record))) {
      signalProcessGroup(processGroupId, "SIGKILL");
      results.push({ pid: record.pid, role: record.role, signal: "SIGKILL", status: "signaled" });
    }

    if (await isSameProcess(record)) survivors.push(record);
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
  await writeFile(context.paths.processRegistry, `${JSON.stringify({ processes }, null, 2)}\n`);
}

async function isSameProcess(record: ProcessRecord): Promise<boolean> {
  return (await readProcessInfo(record.pid))?.startTimeTicks === record.startTimeTicks;
}

async function readProcessInfo(pid: number): Promise<{ startTimeTicks: string } | null> {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, "utf8");
    const fields = stat
      .slice(stat.lastIndexOf(")") + 2)
      .trim()
      .split(/\s+/);
    return { startTimeTicks: fields[19]! };
  } catch {
    return null;
  }
}

function safeProcessGroupId(record: ProcessRecord): number | null {
  if (record.processGroupId === undefined) return record.pid;
  return record.processGroupId === record.pid ? record.processGroupId : null;
}

function signalProcessGroup(pid: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(-pid, signal);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    return false;
  }
}
