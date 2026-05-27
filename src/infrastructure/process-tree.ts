import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

import { hasLinuxAncestorPid, isPositiveSafeInteger, linuxProcessKey, type LinuxProcessSnapshot, readLinuxProcessSnapshot, readLinuxProcessSnapshots, sameLinuxProcess } from "./linux-process.js";

export const processTreeOwnerEnvKey = "ROADRUNNER_PROCESS_TREE_OWNER";

export interface ProcessTreeRoot {
  ownerToken?: string;
  pid: number;
  processGroupId: number;
  startTimeTicks: string;
}

export function createProcessTreeOwnerToken(): string {
  return randomUUID();
}

export function readCurrentProcessTreeRoot(pid: number | undefined, ownerToken?: string): ProcessTreeRoot | null {
  const snapshot = pid === undefined ? null : readLinuxProcessSnapshot(pid);
  return snapshot ? { ownerToken, pid: snapshot.pid, processGroupId: snapshot.processGroupId, startTimeTicks: snapshot.startTimeTicks } : null;
}

export function processTreeExists(root: ProcessTreeRoot | null | undefined): boolean {
  return processTreeTargets(root).length > 0;
}

export function processTreeSnapshotKeys(root: ProcessTreeRoot | null | undefined): string[] {
  return processTreeTargets(root).map(linuxProcessKey).sort();
}

export function signalProcessTree(root: ProcessTreeRoot | null | undefined, signal: NodeJS.Signals): boolean {
  const targets = processTreeTargets(root);
  let signaled = false;

  const currentRoot = readMatchingRoot(root);
  if (isProcessTreeRoot(root) && currentRoot?.processGroupId === root.processGroupId) signaled = signalProcessGroup(root.processGroupId, signal) || signaled;

  for (const target of targets.reverse()) {
    if (currentRoot && target.processGroupId === currentRoot.processGroupId) continue;
    /* v8 ignore next -- descendant exit or PID reuse between snapshot and signal is nondeterministic. */
    signaled = signalSameLinuxProcess(target, signal) || signaled;
  }

  return signaled;
}

function processTreeTargets(root: ProcessTreeRoot | null | undefined): LinuxProcessSnapshot[] {
  if (!isProcessTreeRoot(root)) return [];
  const snapshots = readLinuxProcessSnapshots();
  const targets = new Map<string, LinuxProcessSnapshot>();
  const currentRoot = snapshots.get(root.pid) ?? null;

  if (sameLinuxProcess(root, currentRoot)) {
    addTarget(targets, currentRoot);
    for (const snapshot of snapshots.values()) {
      if (snapshot.pid !== root.pid && hasLinuxAncestorPid(snapshot.pid, root.pid, snapshots)) addTarget(targets, snapshot);
    }
  }

  if (root.ownerToken) {
    for (const snapshot of snapshots.values()) {
      if (readLinuxProcessOwnerToken(snapshot.pid) === root.ownerToken) addTarget(targets, snapshot);
    }
  }

  return [...targets.values()];
}

function readMatchingRoot(root: ProcessTreeRoot | null | undefined): LinuxProcessSnapshot | null {
  if (!isProcessTreeRoot(root)) return null;
  const snapshot = readLinuxProcessSnapshot(root.pid);
  return sameLinuxProcess(root, snapshot) ? snapshot : null;
}

function addTarget(targets: Map<string, LinuxProcessSnapshot>, snapshot: LinuxProcessSnapshot): void {
  targets.set(linuxProcessKey(snapshot), snapshot);
}

function readLinuxProcessOwnerToken(pid: number): string | null {
  try {
    const environ = readFileSync(`/proc/${pid}/environ`, "utf8");
    const prefix = `${processTreeOwnerEnvKey}=`;
    for (const entry of environ.split("\0")) {
      if (entry.startsWith(prefix)) return entry.slice(prefix.length);
    }
    return null;
  } catch {
    return null;
  }
}

function signalProcessGroup(processGroupId: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(-processGroupId, signal);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    return false;
  }
}

function signalSameLinuxProcess(snapshot: LinuxProcessSnapshot, signal: NodeJS.Signals): boolean {
  const current = readLinuxProcessSnapshot(snapshot.pid);
  /* v8 ignore next -- process exit or PID reuse between snapshot and signal is nondeterministic. */
  if (!sameLinuxProcess(snapshot, current)) return false;
  try {
    process.kill(snapshot.pid, signal);
    return true;
  } catch (error) {
    /* v8 ignore next -- process exit between snapshot and signal is nondeterministic. */
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    /* v8 ignore next -- process exit between snapshot and signal is nondeterministic. */
    return false;
  }
}

function isProcessTreeRoot(value: ProcessTreeRoot | null | undefined): value is ProcessTreeRoot {
  return (
    value !== null &&
    value !== undefined &&
    isPositiveSafeInteger(value.pid) &&
    isPositiveSafeInteger(value.processGroupId) &&
    typeof value.startTimeTicks === "string" &&
    value.startTimeTicks.length > 0 &&
    (value.ownerToken === undefined || value.ownerToken.length > 0)
  );
}
