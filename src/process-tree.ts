import { spawnSync } from "node:child_process";

export function signalProcessTree(pid: number | undefined, signal: NodeJS.Signals): boolean {
  if (!pid) return false;
  /* v8 ignore next -- Windows tree cleanup depends on taskkill availability. */
  if (process.platform === "win32") return signalWindowsProcessTree(pid, signal);
  return signalPosixProcessGroup(pid, signal);
}

export function processTreeExists(pid: number | undefined): boolean {
  if (!pid) return false;

  try {
    process.kill(process.platform === "win32" ? pid : -pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return false;
    if (code === "EPERM") return true;
    throw error;
  }
}

export function windowsTaskkillArgs(pid: number, signal: NodeJS.Signals): string[] {
  const args = ["/PID", String(pid), "/T"];
  if (signal === "SIGKILL") args.push("/F");
  return args;
}

function signalPosixProcessGroup(pid: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(-pid, signal);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    return false;
  }
}

/* v8 ignore start -- covered by pure argument tests; execution requires Windows taskkill. */
function signalWindowsProcessTree(pid: number, signal: NodeJS.Signals): boolean {
  return spawnSync("taskkill", windowsTaskkillArgs(pid, signal), { stdio: "ignore" }).status === 0;
}
/* v8 ignore stop */
