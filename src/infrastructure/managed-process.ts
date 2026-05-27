import { spawn } from "node:child_process";
import type { WriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";

import type { ProjectContext } from "./config.js";
import { registerProcess, unregisterProcessIfProcessGroupExited } from "./process-registry.js";
import { createProcessTreeOwnerToken, processTreeExists, processTreeOwnerEnvKey, readCurrentProcessTreeRoot, signalProcessTree as signalRegisteredProcessTree, type ProcessTreeRoot } from "./process-tree.js";
import { createPrivateWriteStream } from "./run-artifacts.js";
import { verificationChildEnv } from "./child-env.js";
import { createCapturedOutputBuffer } from "./captured-output.js";
import { formatDuration } from "../domain/duration.js";

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
  const output = createCapturedOutputBuffer();
  await mkdir(path.dirname(logPath), { recursive: true });
  const logStream = await createPrivateWriteStream(logPath);
  logStream.on("error", Function.prototype as (error: Error) => void);
  const ownerToken = createProcessTreeOwnerToken();
  const child = spawn(command, [], { cwd: context.root, detached: true, env: { ...verificationChildEnv(), [processTreeOwnerEnvKey]: ownerToken }, shell: true });
  if (!child.pid) {
    await closeLogStream(logStream);
    throw new Error("Failed to start shell process for verification command.");
  }
  let processTreeRoot = readCurrentProcessTreeRoot(child.pid, ownerToken);
  let registeredPid: number | null = child.pid;
  let aborted = false;
  let registrationFailed = false;
  let timedOut = false;
  let timeout: NodeJS.Timeout | undefined;
  let killTimeout: NodeJS.Timeout | undefined;
  let forceKillDone: Promise<void> | undefined;
  let settled = false;
  const appendOutput = (text: string) => {
    output.append(text);
    try {
      logStream.write(text);
    } catch {
      /* Verification logging is best-effort once the command is running. */
    }
  };
  const terminateProcess = (message: string) => {
    if (forceKillDone) return;
    appendOutput(message);
    signalShellProcessTree(processTreeRoot, "SIGTERM");
    ({ done: forceKillDone, timeout: killTimeout } = scheduleProcessTreeKill(processTreeRoot, appendOutput));
  };

  const abortRun = () => {
    if (settled) return;
    aborted = true;
    terminateProcess("Command aborted by Roadrunner control. Sending SIGTERM.\n");
  };

  const registrationDone = registerProcess({ command: [command], cwd: context.root, ownerToken, pid: child.pid, role }, context)
    .then((record) => {
      if (!processTreeRoot && record.processGroupId && record.startTimeTicks) processTreeRoot = { ownerToken, pid: record.pid, processGroupId: record.processGroupId, startTimeTicks: record.startTimeTicks };
    })
    .catch((error: Error) => {
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
      terminateProcess(`Verification command timed out after ${formatTimeout(timeoutMs)}. Sending SIGTERM.\n`);
    }, timeoutMs);
  }

  child.stdout.on("data", (chunk: Buffer) => {
    onOutput?.();
    appendOutput(chunk.toString());
  });
  child.stderr.on("data", (chunk: Buffer) => {
    onOutput?.();
    appendOutput(chunk.toString());
  });

  return new Promise((resolve) => {
    /* v8 ignore start -- shell spawn errors are defensive because commands run through the platform shell. */
    child.on("error", async (error: Error) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", abortRun);
      clearTimeout(timeout);
      await finishScheduledProcessTreeKill(processTreeRoot, forceKillDone, killTimeout);
      appendOutput(`${error.message}\n`);
      await registrationDone;
      await unregisterRegisteredProcess(registeredPid, context);
      await closeLogStream(logStream);
      resolve({ code: 1, output: output.value() });
    });
    /* v8 ignore stop */
    child.on("close", async (code: number | null) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", abortRun);
      clearTimeout(timeout);
      await finishScheduledProcessTreeKill(processTreeRoot, forceKillDone, killTimeout);
      await registrationDone;
      await unregisterRegisteredProcess(registeredPid, context);
      await closeLogStream(logStream);
      resolve({ code: registrationFailed ? 1 : timedOut ? 124 : aborted ? 130 : code, output: output.value() });
    });
  });
}

async function unregisterRegisteredProcess(pid: number | null, context: ProjectContext): Promise<void> {
  if (pid !== null) await unregisterProcessIfProcessGroupExited(pid, context);
}

async function finishScheduledProcessTreeKill(root: ProcessTreeRoot | null, forceKillDone: Promise<void> | undefined, killTimeout: NodeJS.Timeout | undefined): Promise<void> {
  if (forceKillDone && processTreeExists(root)) {
    await forceKillDone;
    return;
  }

  clearTimeout(killTimeout);
}

function scheduleProcessTreeKill(root: ProcessTreeRoot | null, appendOutput: (text: string) => void): { done: Promise<void>; timeout: NodeJS.Timeout } {
  let timeout: NodeJS.Timeout;
  const done = new Promise<void>((resolve) => {
    timeout = setTimeout(() => {
      appendOutput("Process did not exit after SIGTERM. Sending SIGKILL.\n");
      signalShellProcessTree(root, "SIGKILL");
      resolve();
    }, forceKillDelayMs);
  });
  return { done, timeout: timeout! };
}

function signalShellProcessTree(root: ProcessTreeRoot | null, signal: NodeJS.Signals): void {
  try {
    signalRegisteredProcessTree(root, signal);
  } catch {
    /* Cleanup is best-effort after timeout or registration failure. */
  }
}

function closeLogStream(logStream: WriteStream): Promise<void> {
  return new Promise((resolve) => {
    logStream.once("error", resolve);
    logStream.end(() => {
      logStream.off("error", resolve);
      resolve();
    });
  });
}

function formatTimeout(timeoutMs: number): string {
  return `${formatDuration(timeoutMs)} (${timeoutMs} ms)`;
}
