import { readLinuxProcessSnapshot } from "./linux-process.js";

export interface ProcessIdentity {
  pid: number;
  startTimeTicks?: string;
}

export type ProcessIdentityStatus = "different" | "missing" | "same" | "unverifiable";

export async function readProcessInfo(pid: number): Promise<{ processGroupId?: number; startTimeTicks?: string } | null> {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  const snapshot = readLinuxProcessSnapshot(pid);
  return snapshot ? { processGroupId: snapshot.processGroupId, startTimeTicks: snapshot.startTimeTicks } : null;
}

export async function processIdentityStatus(identity: ProcessIdentity): Promise<ProcessIdentityStatus> {
  const info = await readProcessInfo(identity.pid);
  if (!info) return "missing";
  if (identity.startTimeTicks === undefined || info.startTimeTicks === undefined) return "unverifiable";
  return info.startTimeTicks === identity.startTimeTicks ? "same" : "different";
}
