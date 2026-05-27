import { execFile, spawn } from "node:child_process";
import type { WriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import type { ProjectContext } from "../config.js";
import { registerProcess, unregisterProcessIfProcessGroupExited } from "../process-registry.js";
import { createProcessTreeOwnerToken, processTreeExists, processTreeOwnerEnvKey, readCurrentProcessTreeRoot, signalProcessTree, type ProcessTreeRoot } from "../process-tree.js";
import { createPrivateWriteStream, writePrivateFile } from "../run-artifacts.js";
import { providerChildEnv } from "../child-env.js";
import { createCapturedOutputBuffer } from "../captured-output.js";
import { defaultModel, defaultVariant } from "../../domain/provider-defaults.js";
import { openCodeCheckTimeoutMs, providerTimeoutMs } from "../../domain/timeouts.js";
import { formatDuration } from "../../domain/duration.js";
import type { Provider, ProviderRunInput, ProviderRunResult } from "./provider.js";

const nestedOpenCodeEnvKeys = ["OPENCODE_SESSION", "OPENCODE_SESSION_ID", "OPENCODE_SERVER", "OPENCODE_WORKSPACE", "OPENCODE_APP_INFO"];
const forceKillDelayMs = 1_000;
const promptMessage = "Follow the attached Roadrunner prompt file exactly.";
const execFileAsync = promisify(execFile);
const requiredRunFlags = ["--model", "--variant", "--agent", "--file", "--dangerously-skip-permissions"];

export class OpenCodeProvider implements Provider {
  readonly model: string;
  readonly variant: string;

  constructor({ model = defaultModel, variant = defaultVariant } = {}) {
    this.model = model;
    this.variant = variant;
  }

  async run({ agent, bypassProviderPermissions = false, context, env = {}, logPath, onOutput, onStart, prompt, role, signal, streamOutput = true, workspaceAccess }: ProviderRunInput): Promise<ProviderRunResult> {
    const ownerToken = createProcessTreeOwnerToken();
    const childEnv = openCodeRunEnv({ context, env, model: this.model, variant: this.variant, workspaceAccess, bypassProviderPermissions });
    childEnv[processTreeOwnerEnvKey] = ownerToken;
    const output = createCapturedOutputBuffer(childEnv.ROADRUNNER_MAX_CAPTURED_OUTPUT_BYTES);
    await mkdir(path.dirname(logPath), { recursive: true });
    const promptFilePath = await writePromptFile(logPath, prompt);
    const logStream = await createPrivateWriteStream(logPath);
    logStream.on("error", Function.prototype as (error: Error) => void);
    const debug = childEnv.ROADRUNNER_OPENCODE_DEBUG === "1";
    const timeoutMs = providerTimeoutMs(childEnv.ROADRUNNER_PROVIDER_TIMEOUT_MS);
    const args = openCodeRunArgs({ agent, bypassProviderPermissions, debug, model: this.model, promptFilePath, variant: this.variant, workspaceAccess });

    const child = spawn("opencode", args, {
      cwd: context.root,
      detached: true,
      env: childEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let registeredPid: number | null = child.pid ?? null;
    let processTreeRoot = readCurrentProcessTreeRoot(child.pid, ownerToken);
    let aborted = false;
    let registrationFailed = false;
    let timedOut = false;
    let timeout: NodeJS.Timeout | undefined;
    let killTimeout: NodeJS.Timeout | undefined;
    let forceKillDone: Promise<void> | undefined;
    let settled = false;
    const command = ["opencode", ...args.map((argument) => (argument === promptFilePath ? "<prompt-file>" : argument))];

    const appendOutput = (text: string) => {
      writeProviderOutput(logStream, text, (value) => {
        output.append(value);
      });
    };

    const terminateChild = (message: string) => {
      if (forceKillDone) return;
      appendOutput(message);
      if (streamOutput) process.stderr.write(message);
      signalProviderProcessTree(processTreeRoot, "SIGTERM");
      ({ done: forceKillDone, timeout: killTimeout } = scheduleChildProcessGroupKill(processTreeRoot));
    };

    const abortRun = () => {
      if (settled) return;
      aborted = true;
      terminateChild("Provider aborted by Roadrunner control. Sending SIGTERM.\n");
    };

    const registrationDone = child.pid
      ? registerProcess(
          {
            command,
            cwd: context.root,
            ownerToken,
            pid: child.pid,
            role,
          },
          context,
        )
          .then((record) => {
            if (!processTreeRoot && record.processGroupId && record.startTimeTicks) processTreeRoot = { ownerToken, pid: record.pid, processGroupId: record.processGroupId, startTimeTicks: record.startTimeTicks };
          })
          .catch((error: Error) => {
            registeredPid = null;
            /* v8 ignore next -- registration settling after close is a nondeterministic process race. */
            if (settled) return;
            registrationFailed = true;
            terminateChild(`Failed to register provider process: ${error.message}\n`);
          })
      : Promise.resolve();

    if (signal?.aborted) abortRun();
    else signal?.addEventListener("abort", abortRun, { once: true });

    onStart?.({ command, debug, logPath, pid: child.pid ?? null, processTreeRoot, role });

    if (timeoutMs > 0) {
      timeout = setTimeout(() => {
        timedOut = true;
        terminateChild(`Provider timed out after ${formatTimeout(timeoutMs)}. Sending SIGTERM.\n`);
      }, timeoutMs);
    }

    child.stdout.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      onOutput?.();
      appendOutput(text);
      if (streamOutput) process.stdout.write(text);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      onOutput?.();
      appendOutput(text);
      if (streamOutput) process.stderr.write(text);
    });

    return new Promise((resolve) => {
      const onClose = async (code: number | null) => {
        /* v8 ignore next -- close after error is a nondeterministic child-process race. */
        if (settled) return;
        settled = true;
        signal?.removeEventListener("abort", abortRun);
        clearTimeout(timeout);
        await finishScheduledChildProcessGroupKill(processTreeRoot, forceKillDone, killTimeout);
        await registrationDone;
        await unregisterRegisteredProcess(registeredPid, context);
        await closeLogStream(logStream);
        resolve({ code: registrationFailed ? 1 : timedOut ? 124 : aborted ? 130 : code, output: output.value() });
      };

      child.on("error", async (error: Error) => {
        child.off("close", onClose);
        signal?.removeEventListener("abort", abortRun);
        clearTimeout(timeout);
        await finishScheduledChildProcessGroupKill(processTreeRoot, forceKillDone, killTimeout);
        appendOutput(`${error.message}\n`);
        await registrationDone;
        await unregisterRegisteredProcess(registeredPid, context);
        await closeLogStream(logStream);
        resolve({ code: 1, output: output.value() });
      });
      child.on("close", onClose);
    });
  }
}

export async function validateOpenCodeCli(): Promise<string[]> {
  try {
    const timeoutMs = openCodeCheckTimeoutMs(process.env.ROADRUNNER_OPENCODE_CHECK_TIMEOUT_MS);
    const result = await execFileAsync("opencode", ["run", "--help"], { killSignal: "SIGKILL", timeout: timeoutMs });
    const help = `${result.stdout}\n${result.stderr}`;
    const flags = new Set(help.match(/--[A-Za-z0-9][A-Za-z0-9-]*/g) ?? []);
    return requiredRunFlags.filter((flag) => !flags.has(flag)).map((flag) => `Installed OpenCode CLI is missing required flag ${flag}; update OpenCode or check that the expected opencode executable is first in PATH.`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).message.includes("ROADRUNNER_OPENCODE_CHECK_TIMEOUT_MS")) return [(error as Error).message];
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return ["OpenCode CLI was not found. Install opencode or ensure the opencode executable is available in PATH."];
    if ((error as { killed?: boolean; signal?: NodeJS.Signals }).killed || (error as { signal?: NodeJS.Signals }).signal === "SIGKILL") {
      return [`opencode run --help timed out after ${formatTimeout(openCodeCheckTimeoutMs(process.env.ROADRUNNER_OPENCODE_CHECK_TIMEOUT_MS))}.`];
    }
    return [`opencode run --help failed: ${(error as Error).message}`];
  }
}

async function writePromptFile(logPath: string, prompt: string): Promise<string> {
  const promptFilePath = path.join(path.dirname(logPath), `${path.basename(logPath, path.extname(logPath))}.prompt-input.md`);
  await writePrivateFile(promptFilePath, prompt);
  return promptFilePath;
}

function writeProviderOutput(logStream: WriteStream, text: string, appendOutput: (text: string) => void): void {
  appendOutput(text);
  try {
    logStream.write(text);
  } catch {
    /* Logging is best-effort once the provider is already running. */
  }
}

function openCodeRunEnv({ bypassProviderPermissions, context, env, model, variant, workspaceAccess }: Pick<ProviderRunInput, "bypassProviderPermissions" | "context" | "env" | "workspaceAccess"> & { model: string; variant: string }): NodeJS.ProcessEnv {
  const childEnv: NodeJS.ProcessEnv = providerChildEnv(process.env, { ...(env ?? {}), OPENCODE_MODEL: model, OPENCODE_VARIANT: variant });
  const nestedIndicator = nestedOpenCodeIndicator(childEnv);
  if (nestedIndicator && !context.config.allowNestedOpenCode) {
    throw new Error(`Refusing to launch a nested OpenCode session (${nestedIndicator} is set). Roadrunner blocks nested sessions to avoid controlling the parent assistant session. Set allowNestedOpenCode: true only if this is intentional.`);
  }
  if (workspaceAccess === "read-only" && bypassProviderPermissions) throw new Error("Read-only provider runs cannot bypass provider permissions; disable dangerouslySkipPermissions for read-only phases.");

  for (const key of nestedOpenCodeEnvKeys) delete childEnv[key];
  return childEnv;
}

function openCodeRunArgs({ agent, bypassProviderPermissions, debug, model, promptFilePath, variant, workspaceAccess }: Pick<ProviderRunInput, "agent" | "bypassProviderPermissions" | "workspaceAccess"> & { debug: boolean; model: string; promptFilePath: string; variant: string }): string[] {
  const args = ["run", "--model", model, "--variant", variant, "--agent", agent, promptMessage, "--file", promptFilePath];
  if (debug) args.push("--print-logs", "--log-level", "DEBUG");
  if (workspaceAccess === "write" && bypassProviderPermissions) args.push("--dangerously-skip-permissions");
  return args;
}

async function unregisterRegisteredProcess(pid: number | null, context: ProjectContext): Promise<void> {
  if (pid !== null) await unregisterProcessIfProcessGroupExited(pid, context);
}

function scheduleChildProcessGroupKill(root: ProcessTreeRoot | null): { done: Promise<void>; timeout: NodeJS.Timeout } {
  let timeout: NodeJS.Timeout;
  const done = new Promise<void>((resolve) => {
    timeout = setTimeout(() => {
      signalProviderProcessTree(root, "SIGKILL");
      resolve();
    }, forceKillDelayMs);
  });

  return { done, timeout: timeout! };
}

/* v8 ignore start -- timeout cleanup timing is covered by black-box provider timeout tests. */
async function finishScheduledChildProcessGroupKill(root: ProcessTreeRoot | null, forceKillDone: Promise<void> | undefined, killTimeout: NodeJS.Timeout | undefined): Promise<void> {
  if (forceKillDone && processTreeExists(root)) {
    await forceKillDone;
    return;
  }

  clearTimeout(killTimeout);
}

/* v8 ignore stop */

function signalProviderProcessTree(root: ProcessTreeRoot | null, signal: NodeJS.Signals): void {
  try {
    signalProcessTree(root, signal);
  } catch {
    /* Best effort: timeout cleanup is also covered by the process registry cleanup command. */
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

function nestedOpenCodeIndicator(env: NodeJS.ProcessEnv): string | null {
  for (const key of nestedOpenCodeEnvKeys) {
    if (env[key]) return key;
  }
  return null;
}

function formatTimeout(timeoutMs: number): string {
  return `${formatDuration(timeoutMs)} (${timeoutMs} ms)`;
}
