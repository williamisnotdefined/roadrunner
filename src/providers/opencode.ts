import { execFile, spawn } from "node:child_process";
import { createWriteStream, type WriteStream } from "node:fs";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { defaultModel, defaultVariant, type ProjectContext } from "../config.js";
import { registerProcess, unregisterProcess } from "../process-registry.js";

export interface ProviderRunInput {
  agent: string;
  context: ProjectContext;
  env?: Record<string, string>;
  logPath: string;
  onStart?: (event: ProviderStartEvent) => void;
  prompt: string;
  role: string;
  skipPermissions?: boolean;
}

export interface ProviderStartEvent {
  command: string[];
  debug: boolean;
  logPath: string;
  pid: number | null;
  role: string;
}

export interface ProviderRunResult {
  code: number | null;
  output: string;
}

const nestedOpenCodeEnvKeys = ["OPENCODE_SESSION", "OPENCODE_SESSION_ID", "OPENCODE_SERVER", "OPENCODE_WORKSPACE", "OPENCODE_APP_INFO"];
const defaultProviderTimeoutMs = 30 * 60 * 1000;
const defaultOpenCodeCheckTimeoutMs = 10_000;
const forceKillDelayMs = 1_000;
const promptMessage = "Follow the attached Roadrunner prompt file exactly.";
const execFileAsync = promisify(execFile);
const requiredRunFlags = ["--model", "--variant", "--agent", "--file", "--dangerously-skip-permissions"];

export class OpenCodeProvider {
  readonly model: string;
  readonly variant: string;

  constructor({ model = defaultModel, variant = defaultVariant } = {}) {
    this.model = model;
    this.variant = variant;
  }

  async run({ agent, context, env = {}, logPath, onStart, prompt, role, skipPermissions = false }: ProviderRunInput): Promise<ProviderRunResult> {
    const childEnv: NodeJS.ProcessEnv = { ...process.env, ...env, OPENCODE_MODEL: this.model, OPENCODE_VARIANT: this.variant };
    const nestedIndicator = nestedOpenCodeIndicator(childEnv);
    if (nestedIndicator && !context.config.allowNestedOpenCode) {
      throw new Error(`Refusing to launch nested OpenCode session (${nestedIndicator} is set). Set allowNestedOpenCode: true to override.`);
    }

    for (const key of nestedOpenCodeEnvKeys) delete childEnv[key];

    await mkdir(path.dirname(logPath), { recursive: true });
    const promptFilePath = await writePromptFile(logPath, prompt);
    const logStream = createWriteStream(logPath, { flags: "w", mode: 0o600 });
    logStream.on("error", Function.prototype as (error: Error) => void);
    const debug = childEnv.ROADRUNNER_OPENCODE_DEBUG === "1";
    const timeoutMs = providerTimeoutMs(childEnv.ROADRUNNER_PROVIDER_TIMEOUT_MS);
    const args = ["run", "--model", this.model, "--variant", this.variant, "--agent", agent, promptMessage, "--file", promptFilePath];

    if (debug) args.push("--print-logs", "--log-level", "DEBUG");

    if (skipPermissions) args.push("--dangerously-skip-permissions");

    const child = spawn("opencode", args, {
      cwd: context.root,
      detached: true,
      env: childEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let output = "";
    let registeredPid: number | null = child.pid ?? null;
    let registrationFailed = false;
    let timedOut = false;
    let timeout: NodeJS.Timeout | undefined;
    let killTimeout: NodeJS.Timeout | undefined;
    let forceKillDone: Promise<void> | undefined;
    let settled = false;
    const command = ["opencode", ...args.map((argument) => (argument === promptFilePath ? "<prompt-file>" : argument))];

    const appendOutput = (text: string) => {
      writeProviderOutput(logStream, text, (value) => {
        output += value;
      });
    };

    const registrationDone = child.pid
      ? registerProcess(
          {
            command,
            cwd: context.root,
            pid: child.pid,
            role,
          },
          context,
        ).catch((error: Error) => {
          registeredPid = null;
          /* v8 ignore next -- registration settling after close is a nondeterministic process race. */
          if (settled) return;
          registrationFailed = true;
          appendOutput(`Failed to register provider process: ${error.message}\n`);
          signalChildProcessGroup(child.pid, "SIGTERM");
          ({ done: forceKillDone, timeout: killTimeout } = scheduleChildProcessGroupKill(child.pid));
        })
      : Promise.resolve();

    onStart?.({ command, debug, logPath, pid: child.pid ?? null, role });

    if (timeoutMs > 0) {
      timeout = setTimeout(() => {
        timedOut = true;
        const message = `Provider timed out after ${timeoutMs} ms. Sending SIGTERM.\n`;
        appendOutput(message);
        process.stderr.write(message);
        signalChildProcessGroup(child.pid, "SIGTERM");
        ({ done: forceKillDone, timeout: killTimeout } = scheduleChildProcessGroupKill(child.pid));
      }, timeoutMs);
    }

    child.stdout.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      appendOutput(text);
      process.stdout.write(text);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      appendOutput(text);
      process.stderr.write(text);
    });

    return new Promise((resolve) => {
      const onClose = async (code: number | null) => {
        /* v8 ignore next -- close after error is a nondeterministic child-process race. */
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        await finishScheduledChildProcessGroupKill(child.pid, forceKillDone, killTimeout);
        await registrationDone;
        await unregisterRegisteredProcess(registeredPid, context);
        await closeLogStream(logStream);
        resolve({ code: registrationFailed ? 1 : timedOut ? 124 : code, output });
      };

      child.on("error", async (error: Error) => {
        child.off("close", onClose);
        clearTimeout(timeout);
        await finishScheduledChildProcessGroupKill(child.pid, forceKillDone, killTimeout);
        appendOutput(`${error.message}\n`);
        await registrationDone;
        await unregisterRegisteredProcess(registeredPid, context);
        await closeLogStream(logStream);
        resolve({ code: 1, output });
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
    return requiredRunFlags.filter((flag) => !help.includes(flag)).map((flag) => `opencode run --help is missing required flag ${flag}.`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).message.includes("ROADRUNNER_OPENCODE_CHECK_TIMEOUT_MS")) return [(error as Error).message];
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return ["opencode must be installed and available in PATH."];
    if ((error as { killed?: boolean; signal?: NodeJS.Signals }).killed || (error as { signal?: NodeJS.Signals }).signal === "SIGKILL") {
      return [`opencode run --help timed out after ${openCodeCheckTimeoutMs(process.env.ROADRUNNER_OPENCODE_CHECK_TIMEOUT_MS)} ms.`];
    }
    return [`opencode run --help failed: ${(error as Error).message}`];
  }
}

async function writePromptFile(logPath: string, prompt: string): Promise<string> {
  const promptFilePath = path.join(path.dirname(logPath), `${path.basename(logPath, path.extname(logPath))}.prompt-input.md`);
  await writeFile(promptFilePath, prompt, { mode: 0o600 });
  await chmod(promptFilePath, 0o600);
  return promptFilePath;
}

function providerTimeoutMs(value: string | undefined): number {
  if (value === undefined) return defaultProviderTimeoutMs;
  const timeoutMs = Number(value);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0) throw new Error(`ROADRUNNER_PROVIDER_TIMEOUT_MS must be a non-negative integer, got ${value}.`);
  return timeoutMs;
}

function openCodeCheckTimeoutMs(value: string | undefined): number {
  if (value === undefined) return defaultOpenCodeCheckTimeoutMs;
  const timeoutMs = Number(value);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new Error(`ROADRUNNER_OPENCODE_CHECK_TIMEOUT_MS must be a positive integer, got ${value}.`);
  return timeoutMs;
}

function writeProviderOutput(logStream: WriteStream, text: string, appendOutput: (text: string) => void): void {
  appendOutput(text);
  try {
    logStream.write(text);
  } catch {
    /* Logging is best-effort once the provider is already running. */
  }
}

async function unregisterRegisteredProcess(pid: number | null, context: ProjectContext): Promise<void> {
  if (pid !== null) await unregisterProcess(pid, context);
}

function signalChildProcessGroup(pid: number | undefined, signal: NodeJS.Signals): void {
  /* v8 ignore next -- spawned provider processes have a pid before timeout signaling. */
  if (!pid) return;

  try {
    process.kill(process.platform === "win32" ? pid : -pid, signal);
  } catch {
    /* v8 ignore start -- process may exit between timeout scheduling and signaling. */
    /* Best effort: timeout cleanup is also covered by the process registry cleanup command. */
    /* v8 ignore stop */
  }
}

function scheduleChildProcessGroupKill(pid: number | undefined): { done: Promise<void>; timeout: NodeJS.Timeout } {
  let timeout: NodeJS.Timeout;
  const done = new Promise<void>((resolve) => {
    timeout = setTimeout(() => {
      signalChildProcessGroup(pid, "SIGKILL");
      resolve();
    }, forceKillDelayMs);
  });

  return { done, timeout: timeout! };
}

/* v8 ignore start -- timeout cleanup timing is covered by black-box provider timeout tests. */
async function finishScheduledChildProcessGroupKill(pid: number | undefined, forceKillDone: Promise<void> | undefined, killTimeout: NodeJS.Timeout | undefined): Promise<void> {
  if (forceKillDone && childProcessGroupExists(pid)) {
    await forceKillDone;
    return;
  }

  clearTimeout(killTimeout);
}

function childProcessGroupExists(pid: number | undefined): boolean {
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
/* v8 ignore stop */

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
