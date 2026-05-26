import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface ProcessIdentity {
  pid: number;
  startTimeTicks?: string;
}

export type ProcessIdentityStatus = "different" | "missing" | "same" | "unverifiable";

export async function readProcessInfo(pid: number): Promise<{ startTimeTicks?: string } | null> {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  if (process.platform === "linux") return readLinuxProcessInfo(pid);
  /* v8 ignore next -- exercised only on macOS/BSD hosts. */
  if (process.platform === "darwin" || process.platform === "freebsd" || process.platform === "openbsd") return readPsProcessInfo(pid);
  /* v8 ignore next -- exercised only on Windows hosts. */
  if (process.platform === "win32") return readWindowsProcessInfo(pid);
  /* v8 ignore next -- unknown Node platforms fall back to existence-only identity. */
  return processExists(pid) ? {} : null;
}

async function readLinuxProcessInfo(pid: number): Promise<{ startTimeTicks?: string } | null> {
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

/* v8 ignore start -- platform-specific process identity fallback. */
async function readPsProcessInfo(pid: number): Promise<{ startTimeTicks?: string } | null> {
  try {
    const result = await execFileAsync("ps", ["-p", String(pid), "-o", "lstart="], { timeout: 1000 });
    const startedAt = result.stdout.trim();
    return startedAt.length > 0 ? { startTimeTicks: startedAt } : null;
  } catch {
    return processExists(pid) ? {} : null;
  }
}

async function readWindowsProcessInfo(pid: number): Promise<{ startTimeTicks?: string } | null> {
  try {
    const command = `(Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}").CreationDate`;
    const result = await execFileAsync("powershell.exe", ["-NoProfile", "-Command", command], { timeout: 1000 });
    const startedAt = result.stdout.trim();
    return startedAt.length > 0 ? { startTimeTicks: startedAt } : null;
  } catch {
    return processExists(pid) ? {} : null;
  }
}
/* v8 ignore stop */

export async function processIdentityStatus(identity: ProcessIdentity): Promise<ProcessIdentityStatus> {
  const info = await readProcessInfo(identity.pid);
  if (!info) return "missing";
  if (identity.startTimeTicks === undefined || info.startTimeTicks === undefined) return "unverifiable";
  return info.startTimeTicks === identity.startTimeTicks ? "same" : "different";
}

/* v8 ignore next -- non-Linux fallback helper. */
export function processExists(pid: number): boolean {
  /* v8 ignore start -- exercised only by non-Linux process identity fallback. */
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
  /* v8 ignore stop */
}
