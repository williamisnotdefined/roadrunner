import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { pathExists, projectPaths } from "./config.mjs";

export async function readProcesses(projectRoot = process.cwd()) {
  const registry = projectPaths(projectRoot).processRegistry;
  if (!(await pathExists(registry))) return [];
  try {
    return JSON.parse(await readFile(registry, "utf8")).processes ?? [];
  } catch {
    return [];
  }
}

export async function registerProcess(record, projectRoot = process.cwd()) {
  const info = await readProcessInfo(record.pid);
  if (!info) throw new Error(`Cannot register pid ${record.pid}.`);
  const processes = (await readProcesses(projectRoot)).filter((process) => process.pid !== record.pid);
  processes.push({ ...record, processGroupId: record.pid, startTimeTicks: info.startTimeTicks, startedAt: new Date().toISOString() });
  await writeProcesses(processes, projectRoot);
}

export async function unregisterProcess(pid, projectRoot = process.cwd()) {
  await writeProcesses((await readProcesses(projectRoot)).filter((process) => process.pid !== pid), projectRoot);
}

export async function cleanupProcesses(projectRoot = process.cwd(), { force = false } = {}) {
  const survivors = [];
  const results = [];

  for (const record of await readProcesses(projectRoot)) {
    if (!(await isSameProcess(record))) {
      results.push({ pid: record.pid, role: record.role, status: "stale" });
      continue;
    }

    const signaled = signalProcessGroup(record.processGroupId ?? record.pid, "SIGTERM");
    results.push({ pid: record.pid, role: record.role, signal: "SIGTERM", status: signaled ? "signaled" : "missing" });
    await sleep(1000);

    if (force && (await isSameProcess(record))) {
      signalProcessGroup(record.processGroupId ?? record.pid, "SIGKILL");
      results.push({ pid: record.pid, role: record.role, signal: "SIGKILL", status: "signaled" });
    }

    if (await isSameProcess(record)) survivors.push(record);
  }

  await writeProcesses(survivors, projectRoot);
  return results;
}

async function writeProcesses(processes, projectRoot) {
  const registry = projectPaths(projectRoot).processRegistry;
  await mkdir(path.dirname(registry), { recursive: true });
  if (processes.length === 0) {
    await rm(registry, { force: true });
    return;
  }
  await writeFile(registry, `${JSON.stringify({ processes }, null, 2)}\n`);
}

async function isSameProcess(record) {
  return (await readProcessInfo(record.pid))?.startTimeTicks === record.startTimeTicks;
}

async function readProcessInfo(pid) {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, "utf8");
    return { startTimeTicks: stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/)[19] };
  } catch {
    return null;
  }
}

function signalProcessGroup(pid, signal) {
  try {
    process.kill(-pid, signal);
    return true;
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
    return false;
  }
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
