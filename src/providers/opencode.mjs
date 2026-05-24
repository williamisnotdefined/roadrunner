import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { defaultModel, defaultVariant } from "../config.mjs";
import { registerProcess, unregisterProcess } from "../process-registry.mjs";

export class OpenCodeProvider {
  constructor({ model = defaultModel, variant = defaultVariant } = {}) {
    this.model = model;
    this.variant = variant;
  }

  async run({ agent, cwd, env = {}, logPath, prompt, role, skipPermissions = true }) {
    await mkdir(path.dirname(logPath), { recursive: true });
    const args = ["run", "--model", this.model, "--variant", this.variant, "--agent", agent];

    if (skipPermissions) args.push("--dangerously-skip-permissions");
    args.push(prompt);

    const child = spawn("opencode", args, {
      cwd,
      detached: true,
      env: { ...process.env, ...env, OPENCODE_MODEL: this.model, OPENCODE_VARIANT: this.variant },
    });

    let output = "";
    let registered = false;

    if (child.pid) {
      await registerProcess(
        {
          command: ["opencode", "run", "--model", this.model, "--variant", this.variant, "--agent", agent, "<prompt>"],
          cwd,
          pid: child.pid,
          role,
        },
        cwd,
      );
      registered = true;
    }

    child.stdout.on("data", (chunk) => {
      const text = chunk.toString();
      output += text;
      process.stdout.write(text);
    });
    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      output += text;
      process.stderr.write(text);
    });

    return new Promise((resolve) => {
      child.on("error", async (error) => {
        output += `${error.message}\n`;
        if (registered) await unregisterProcess(child.pid, cwd);
        await writeFile(logPath, output);
        resolve({ code: 1, output });
      });
      child.on("close", async (code) => {
        if (registered) await unregisterProcess(child.pid, cwd);
        await writeFile(logPath, output);
        resolve({ code, output });
      });
    });
  }
}
