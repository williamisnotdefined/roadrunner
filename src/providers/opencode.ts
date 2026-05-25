import { spawn } from "node:child_process";
import { createWriteStream, type WriteStream } from "node:fs";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

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
const promptMessage = "Follow the attached Roadrunner prompt file exactly.";

export class OpenCodeProvider {
  readonly model: string;
  readonly variant: string;

  constructor({ model = defaultModel, variant = defaultVariant } = {}) {
    this.model = model;
    this.variant = variant;
  }

  async run({ agent, context, env = {}, logPath, onStart, prompt, role, skipPermissions = true }: ProviderRunInput): Promise<ProviderRunResult> {
    const childEnv: NodeJS.ProcessEnv = { ...process.env, ...env, OPENCODE_MODEL: this.model, OPENCODE_VARIANT: this.variant };
    const nestedIndicator = nestedOpenCodeIndicator(childEnv);
    if (nestedIndicator && !context.config.allowNestedOpenCode) {
      throw new Error(`Refusing to launch nested OpenCode session (${nestedIndicator} is set). Set allowNestedOpenCode: true to override.`);
    }

    if (!context.config.allowNestedOpenCode) for (const key of nestedOpenCodeEnvKeys) delete childEnv[key];

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
          /* v8 ignore next -- close can win the race before registration fails. */
          if (settled) return;
          registrationFailed = true;
          appendOutput(`Failed to register provider process: ${error.message}\n`);
          signalChildProcessGroup(child.pid, "SIGTERM");
          killTimeout = setTimeout(signalChildProcessGroup, 5_000, child.pid, "SIGKILL");
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
        killTimeout = setTimeout(signalChildProcessGroup, 5_000, child.pid, "SIGKILL");
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
        /* v8 ignore next -- close is detached before the spawn error handler resolves. */
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        clearTimeout(killTimeout);
        await registrationDone;
        await unregisterRegisteredProcess(registeredPid, context);
        await closeLogStream(logStream);
        resolve({ code: registrationFailed ? 1 : timedOut ? 124 : code, output });
      };

      child.on("error", async (error: Error) => {
        child.off("close", onClose);
        clearTimeout(timeout);
        clearTimeout(killTimeout);
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

function writeProviderOutput(logStream: WriteStream, text: string, appendOutput: (text: string) => void): void {
  appendOutput(text);
  /* v8 ignore start -- stream write failures depend on filesystem errors during provider execution. */
  try {
    if (!logStream.destroyed) logStream.write(text);
  } catch {
    /* Logging is best-effort once the provider is already running. */
  }
  /* v8 ignore stop */
}

async function unregisterRegisteredProcess(pid: number | null, context: ProjectContext): Promise<void> {
  if (pid !== null) await unregisterProcess(pid, context);
}

function signalChildProcessGroup(pid: number | undefined, signal: NodeJS.Signals): void {
  /* v8 ignore next -- timeouts only run after successful spawns expose a pid. */
  if (!pid) return;

  try {
    /* v8 ignore next -- Windows process-tree signaling is covered by platform branching at runtime. */
    process.kill(process.platform === "win32" ? pid : -pid, signal);
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
