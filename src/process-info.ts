import { readFile } from "node:fs/promises";

export interface ProcessIdentity {
  pid: number;
  startTimeTicks?: string;
}

export type ProcessIdentityStatus = "different" | "missing" | "same" | "unverifiable";

export async function readProcessInfo(pid: number): Promise<{ startTimeTicks?: string } | null> {
  /* v8 ignore next -- non-Linux cleanup fails closed because no start-time identity is available. */
  if (process.platform !== "linux") return processExists(pid) ? {} : null;

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

export async function processIdentityStatus(identity: ProcessIdentity): Promise<ProcessIdentityStatus> {
  const info = await readProcessInfo(identity.pid);
  if (!info) return "missing";
  if (identity.startTimeTicks === undefined || info.startTimeTicks === undefined) return "unverifiable";
  return info.startTimeTicks === identity.startTimeTicks ? "same" : "different";
}

/* v8 ignore next -- non-Linux fallback helper. */
export function processExists(pid: number): boolean {
  /* v8 ignore start -- exercised only by non-Linux process identity fallback. */
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
  /* v8 ignore stop */
}
