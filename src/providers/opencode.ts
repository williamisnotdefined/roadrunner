import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { defaultModel, defaultVariant, type ProjectContext } from "../config.js";
import { registerProcess, unregisterProcess } from "../process-registry.js";

export interface ProviderRunInput {
  agent: string;
  context: ProjectContext;
  env?: Record<string, string>;
  logPath: string;
  prompt: string;
  role: string;
  skipPermissions?: boolean;
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

  async run({ agent, context, env = {}, logPath, prompt, role, skipPermissions = true }: ProviderRunInput): Promise<ProviderRunResult> {
    const nestedIndicator = nestedOpenCodeIndicator(process.env);
    if (nestedIndicator && !context.config.allowNestedOpenCode) {
      throw new Error(`Refusing to launch nested OpenCode session (${nestedIndicator} is set). Set allowNestedOpenCode: true to override.`);
    }

    await mkdir(path.dirname(logPath), { recursive: true });
    const args = ["run", "--model", this.model, "--variant", this.variant, "--agent", agent];

    if (skipPermissions) args.push("--dangerously-skip-permissions");
    args.push(prompt);

    const childEnv: NodeJS.ProcessEnv = { ...process.env, ...env, OPENCODE_MODEL: this.model, OPENCODE_VARIANT: this.variant };
    for (const key of nestedOpenCodeEnvKeys) delete childEnv[key];

    const child = spawn("opencode", args, {
      cwd: context.root,
      detached: true,
      env: childEnv,
    });

    let output = "";
    let registered = false;

    if (child.pid) {
      await registerProcess(
        {
          command: ["opencode", "run", "--model", this.model, "--variant", this.variant, "--agent", agent, "<prompt>"],
          cwd: context.root,
          pid: child.pid,
          role,
        },
        context,
      );
      registered = true;
    }

    child.stdout.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      output += text;
      process.stdout.write(text);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      output += text;
      process.stderr.write(text);
    });

    return new Promise((resolve) => {
      child.on("error", async (error: Error) => {
        output += `${error.message}\n`;
        /* v8 ignore next -- spawn errors normally happen before Node exposes a pid. */
        if (registered && child.pid) await unregisterProcess(child.pid, context);
        await writeFile(logPath, output);
        resolve({ code: 1, output });
      });
      child.on("close", async (code: number | null) => {
        if (registered && child.pid) await unregisterProcess(child.pid, context);
        await writeFile(logPath, output);
        resolve({ code, output });
      });
    });
  }
}

function nestedOpenCodeIndicator(env: NodeJS.ProcessEnv): string | null {
  for (const key of nestedOpenCodeEnvKeys) {
    if (env[key]) return key;
  }
  return null;
}
