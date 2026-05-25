import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";

import type { ProjectContext } from "./config.js";
import { registerProcess, unregisterProcess } from "./process-registry.js";
import { writePrivateFile } from "./run-artifacts.js";

const forceKillDelayMs = 1_000;

export async function runShell(context: ProjectContext, command: string, logPath: string, role: string, timeoutMs = 0): Promise<{ code: number | null; output: string }> {
  await mkdir(path.dirname(logPath), { recursive: true });
  const child = spawn(command, [], { cwd: context.root, detached: process.platform !== "win32", env: process.env, shell: true });
  let output = "";
  if (!child.pid) throw new Error("Failed to start shell process.");
  let registeredPid: number | null = child.pid;
  let registrationFailed = false;
  let timedOut = false;
  let timeout: NodeJS.Timeout | undefined;
  let killTimeout: NodeJS.Timeout | undefined;
  let forceKillDone: Promise<void> | undefined;
  let settled = false;
  const registrationDone = registerProcess({ command: [command], cwd: context.root, pid: child.pid, role }, context).catch((error: Error) => {
    registeredPid = null;
    if (settled) return;
    registrationFailed = true;
    output += `Failed to register shell process: ${error.message}\n`;
    signalProcessTree(child.pid, "SIGTERM");
    ({ done: forceKillDone, timeout: killTimeout } = scheduleProcessTreeKill(child.pid, (text) => {
      output += text;
    }));
  });

  if (timeoutMs > 0) {
    timeout = setTimeout(() => {
      timedOut = true;
      output += `Command timed out after ${timeoutMs} ms. Sending SIGTERM.\n`;
      signalProcessTree(child.pid, "SIGTERM");
      ({ done: forceKillDone, timeout: killTimeout } = scheduleProcessTreeKill(child.pid, (text) => {
        output += text;
      }));
    }, timeoutMs);
  }

  child.stdout.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });
  child.stderr.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });

  return new Promise((resolve) => {
    /* v8 ignore start -- shell spawn errors are defensive because commands run through the platform shell. */
    child.on("error", async (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (forceKillDone) await forceKillDone;
      else clearTimeout(killTimeout);
      output += `${error.message}\n`;
      await registrationDone;
      if (registeredPid !== null) await unregisterProcess(registeredPid, context);
      await writePrivateFile(logPath, output);
      resolve({ code: 1, output });
    });
    /* v8 ignore stop */
    child.on("close", async (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (forceKillDone) await forceKillDone;
      else clearTimeout(killTimeout);
      await registrationDone;
      if (registeredPid !== null) await unregisterProcess(registeredPid, context);
      await writePrivateFile(logPath, output);
      resolve({ code: registrationFailed ? 1 : timedOut ? 124 : code, output });
    });
  });
}

function signalProcessTree(pid: number | undefined, signal: NodeJS.Signals): void {
  if (!pid) return;
  try {
    process.kill(process.platform === "win32" ? pid : -pid, signal);
  } catch {
    /* Cleanup is best-effort after timeout or registration failure. */
  }
}

function scheduleProcessTreeKill(pid: number | undefined, appendOutput: (text: string) => void): { done: Promise<void>; timeout: NodeJS.Timeout } {
  let timeout: NodeJS.Timeout;
  const done = new Promise<void>((resolve) => {
    timeout = setTimeout(() => {
      appendOutput("Process did not exit after SIGTERM. Sending SIGKILL.\n");
      signalProcessTree(pid, "SIGKILL");
      resolve();
    }, forceKillDelayMs);
  });
  return { done, timeout: timeout! };
}
