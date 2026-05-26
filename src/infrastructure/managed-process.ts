import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";

import type { ProjectContext } from "./config.js";
import { registerProcess, unregisterProcess } from "./process-registry.js";
import { signalProcessTree as signalRegisteredProcessTree } from "./process-tree.js";
import { writePrivateFile } from "./run-artifacts.js";

const forceKillDelayMs = 1_000;

export interface RunShellOptions {
  onOutput?: () => void;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export async function runShell(
  context: ProjectContext,
  command: string,
  logPath: string,
  role: string,
  { onOutput, signal, timeoutMs = 0 }: RunShellOptions = {},
): Promise<{ code: number | null; output: string }> {
  await mkdir(path.dirname(logPath), { recursive: true });
  const child = spawn(command, [], { cwd: context.root, detached: process.platform !== "win32", env: process.env, shell: true });
  let output = "";
  if (!child.pid) throw new Error("Failed to start shell process.");
  let registeredPid: number | null = child.pid;
  let aborted = false;
  let registrationFailed = false;
  let timedOut = false;
  let timeout: NodeJS.Timeout | undefined;
  let killTimeout: NodeJS.Timeout | undefined;
  let forceKillDone: Promise<void> | undefined;
  let settled = false;
  const terminateProcess = (message: string) => {
    if (forceKillDone) return;
    output += message;
    signalShellProcessTree(child.pid, "SIGTERM");
    ({ done: forceKillDone, timeout: killTimeout } = scheduleProcessTreeKill(child.pid, (text) => {
      output += text;
    }));
  };

  const abortRun = () => {
    if (settled) return;
    aborted = true;
    terminateProcess("Command aborted by Roadrunner control. Sending SIGTERM.\n");
  };

  const registrationDone = registerProcess({ command: [command], cwd: context.root, pid: child.pid, role }, context).catch((error: Error) => {
    registeredPid = null;
    if (settled) return;
    registrationFailed = true;
    terminateProcess(`Failed to register shell process: ${error.message}\n`);
  });

  if (signal?.aborted) abortRun();
  else signal?.addEventListener("abort", abortRun, { once: true });

  if (timeoutMs > 0) {
    timeout = setTimeout(() => {
      timedOut = true;
      terminateProcess(`Command timed out after ${timeoutMs} ms. Sending SIGTERM.\n`);
    }, timeoutMs);
  }

  child.stdout.on("data", (chunk: Buffer) => {
    onOutput?.();
    output += chunk.toString();
  });
  child.stderr.on("data", (chunk: Buffer) => {
    onOutput?.();
    output += chunk.toString();
  });

  return new Promise((resolve) => {
    /* v8 ignore start -- shell spawn errors are defensive because commands run through the platform shell. */
    child.on("error", async (error: Error) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", abortRun);
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
      signal?.removeEventListener("abort", abortRun);
      clearTimeout(timeout);
      if (forceKillDone) await forceKillDone;
      else clearTimeout(killTimeout);
      await registrationDone;
      if (registeredPid !== null) await unregisterProcess(registeredPid, context);
      await writePrivateFile(logPath, output);
      resolve({ code: registrationFailed ? 1 : timedOut ? 124 : aborted ? 130 : code, output });
    });
  });
}

function scheduleProcessTreeKill(pid: number | undefined, appendOutput: (text: string) => void): { done: Promise<void>; timeout: NodeJS.Timeout } {
  let timeout: NodeJS.Timeout;
  const done = new Promise<void>((resolve) => {
    timeout = setTimeout(() => {
      appendOutput("Process did not exit after SIGTERM. Sending SIGKILL.\n");
      signalShellProcessTree(pid, "SIGKILL");
      resolve();
    }, forceKillDelayMs);
  });
  return { done, timeout: timeout! };
}

function signalShellProcessTree(pid: number | undefined, signal: NodeJS.Signals): void {
  try {
    signalRegisteredProcessTree(pid, signal);
  } catch {
    /* Cleanup is best-effort after timeout or registration failure. */
  }
}
