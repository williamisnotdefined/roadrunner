import { spawn } from "node:child_process";
import { createWriteStream, type WriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
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

export class OpenCodeProvider {
  readonly model: string;
  readonly variant: string;

  constructor({ model = defaultModel, variant = defaultVariant } = {}) {
    this.model = model;
    this.variant = variant;
  }

  async run({ agent, context, env = {}, logPath, onStart, prompt, role, skipPermissions = true }: ProviderRunInput): Promise<ProviderRunResult> {
    const nestedIndicator = nestedOpenCodeIndicator(process.env);
    if (nestedIndicator && !context.config.allowNestedOpenCode) {
      throw new Error(`Refusing to launch nested OpenCode session (${nestedIndicator} is set). Set allowNestedOpenCode: true to override.`);
    }

    await mkdir(path.dirname(logPath), { recursive: true });
    const logStream = createWriteStream(logPath, { flags: "w" });
    const childEnv: NodeJS.ProcessEnv = { ...process.env, ...env, OPENCODE_MODEL: this.model, OPENCODE_VARIANT: this.variant };
    const debug = childEnv.ROADRUNNER_OPENCODE_DEBUG === "1";
    const timeoutMs = Number(childEnv.ROADRUNNER_PROVIDER_TIMEOUT_MS ?? 0);
    const args = ["run", "--model", this.model, "--variant", this.variant, "--agent", agent];

    if (debug) args.push("--print-logs", "--log-level", "DEBUG");

    if (skipPermissions) args.push("--dangerously-skip-permissions");
    args.push(prompt);

    for (const key of nestedOpenCodeEnvKeys) delete childEnv[key];

    const child = spawn("opencode", args, {
      cwd: context.root,
      detached: true,
      env: childEnv,
    });

    let output = "";
    let registeredPid: number | null = null;
    let timedOut = false;
    let timeout: NodeJS.Timeout | undefined;
    let killTimeout: NodeJS.Timeout | undefined;
    const command = ["opencode", ...args.slice(0, -1), "<prompt>"];

    onStart?.({ command, debug, logPath, pid: child.pid ?? null, role });

    if (child.pid) {
      await registerProcess(
        {
          command,
          cwd: context.root,
          pid: child.pid,
          role,
        },
        context,
      );
      registeredPid = child.pid;
    }

    if (timeoutMs > 0) {
      timeout = setTimeout(() => {
        timedOut = true;
        const message = `Provider timed out after ${timeoutMs} ms. Sending SIGTERM.\n`;
        writeProviderOutput(logStream, message, (value) => {
          output += value;
        });
        process.stderr.write(message);
        signalChildProcessGroup(child.pid, "SIGTERM");
        /* v8 ignore next 5 -- SIGKILL fallback only runs when a provider ignores SIGTERM. */
        killTimeout = setTimeout(() => {
          writeProviderOutput(logStream, "Provider did not exit after SIGTERM. Sending SIGKILL.\n", (value) => {
            output += value;
          });
          signalChildProcessGroup(child.pid, "SIGKILL");
        }, 5_000);
      }, timeoutMs);
    }

    child.stdout.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      writeProviderOutput(logStream, text, (value) => {
        output += value;
      });
      process.stdout.write(text);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      writeProviderOutput(logStream, text, (value) => {
        output += value;
      });
      process.stderr.write(text);
    });

    return new Promise((resolve) => {
      const onClose = async (code: number | null) => {
        clearTimeout(timeout);
        clearTimeout(killTimeout);
        await unregisterRegisteredProcess(registeredPid, context);
        await closeLogStream(logStream);
        resolve({ code: timedOut ? 124 : code, output });
      };

      child.on("error", async (error: Error) => {
        child.off("close", onClose);
        clearTimeout(timeout);
        clearTimeout(killTimeout);
        writeProviderOutput(logStream, `${error.message}\n`, (value) => {
          output += value;
        });
        await unregisterRegisteredProcess(registeredPid, context);
        await closeLogStream(logStream);
        resolve({ code: 1, output });
      });
      child.on("close", onClose);
    });
  }
}

function writeProviderOutput(logStream: WriteStream, text: string, appendOutput: (text: string) => void): void {
  appendOutput(text);
  logStream.write(text);
}

async function unregisterRegisteredProcess(pid: number | null, context: ProjectContext): Promise<void> {
  if (pid !== null) await unregisterProcess(pid, context);
}

function signalChildProcessGroup(pid: number | undefined, signal: NodeJS.Signals): void {
  /* v8 ignore next -- timeouts only run after successful spawns expose a pid. */
  if (!pid) return;

  try {
    process.kill(-pid, signal);
  } catch {
    /* Best effort: timeout cleanup is also covered by the process registry cleanup command. */
  }
}

function closeLogStream(logStream: WriteStream): Promise<void> {
  return new Promise((resolve, reject) => {
    logStream.once("error", reject);
    logStream.end(() => {
      logStream.off("error", reject);
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
