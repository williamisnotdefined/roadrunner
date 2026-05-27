import { readdirSync, readFileSync } from "node:fs";

export interface LinuxProcessSnapshot {
  parentPid: number;
  pid: number;
  processGroupId: number;
  startTimeTicks: string;
}

export function linuxProcessSnapshotFromStat(pid: number, stat: string): LinuxProcessSnapshot | null {
  if (!isPositiveSafeInteger(pid)) return null;
  const fields = linuxStatFields(stat);
  if (!fields) return null;
  const parentPid = Number(fields[1]);
  const processGroupId = Number(fields[2]);
  const startTimeTicks = fields[19];
  if (!isPositiveSafeInteger(parentPid) || !isPositiveSafeInteger(processGroupId) || startTimeTicks === undefined || startTimeTicks.length === 0) return null;
  return { parentPid, pid, processGroupId, startTimeTicks };
}

export function readLinuxProcessSnapshot(pid: number): LinuxProcessSnapshot | null {
  if (!isPositiveSafeInteger(pid)) return null;
  try {
    return linuxProcessSnapshotFromStat(pid, readFileSync(`/proc/${pid}/stat`, "utf8"));
  } catch {
    return null;
  }
}

export function readLinuxProcessSnapshots(): Map<number, LinuxProcessSnapshot> {
  const snapshots = new Map<number, LinuxProcessSnapshot>();
  let entries: string[];
  try {
    entries = readdirSync("/proc");
  } catch {
    /* v8 ignore next -- /proc access failure is a platform/runtime defensive path. */
    return snapshots;
  }

  for (const entry of entries) {
    const pid = Number(entry);
    if (!isPositiveSafeInteger(pid)) continue;
    const snapshot = readLinuxProcessSnapshot(pid);
    if (snapshot) snapshots.set(pid, snapshot);
  }
  return snapshots;
}

export function hasLinuxAncestorPid(pid: number, ancestorPid: number, snapshots: Map<number, LinuxProcessSnapshot>): boolean {
  const seen = new Set<number>();
  let currentPid = pid;
  while (!seen.has(currentPid)) {
    seen.add(currentPid);
    const parentPid = snapshots.get(currentPid)?.parentPid;
    if (parentPid === undefined) return false;
    if (parentPid === ancestorPid) return true;
    currentPid = parentPid;
  }
  /* v8 ignore next -- Linux parent PID cycles are defensive against inconsistent snapshots. */
  return false;
}

export function sameLinuxProcess(identity: { pid: number; startTimeTicks: string }, snapshot = readLinuxProcessSnapshot(identity.pid)): snapshot is LinuxProcessSnapshot {
  return snapshot !== null && snapshot.startTimeTicks === identity.startTimeTicks;
}

export function linuxProcessKey(process: { pid: number; startTimeTicks: string }): string {
  return `${process.pid}:${process.startTimeTicks}`;
}

export function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function linuxStatFields(stat: string): string[] | null {
  const close = stat.lastIndexOf(")");
  if (close < 0 || stat.length <= close + 2 || stat[close + 1] !== " ") return null;
  const fields = stat.slice(close + 2).trim().split(/\s+/);
  return fields.length >= 20 ? fields : null;
}
