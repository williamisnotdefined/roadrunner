import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

import { defaultModel, defaultVariant, type ProjectContext } from "./config.js";
import { formatStep, markBlocked, markDone, nextStep, readQueue, validateGoals, validateQueueFile, writeQueue, type QueueStep } from "./queue.js";
import { cleanupProcesses } from "./process-registry.js";
import { OpenCodeProvider } from "./providers/opencode.js";

export interface RoadrunnerStatus {
  blocked: number;
  done: number;
  next: QueueStep | null;
  queued: number;
}

export async function status(context: ProjectContext): Promise<RoadrunnerStatus> {
  const queueFile = await readQueue(context);
  const errors = [...(await validateGoals(context)), ...validateQueueFile(queueFile)];
  if (errors.length > 0) throw new Error(errors.join("\n"));

  return {
    blocked: queueFile.blocked.length,
    done: queueFile.history.length,
    next: nextStep(queueFile),
    queued: queueFile.queue.length,
  };
}

export async function plan(context: ProjectContext): Promise<{ logDir: string; result: { code: number | null; output: string }; step: QueueStep } | null> {
  const queueFile = await readQueue(context);
  const step = nextStep(queueFile);
  if (!step) return null;

  const logDir = await createLogDir(context, `${step.id}-plan`);
  const prompt = await renderPrompt(context, "plan-step.md", {
    GOALS_MD: await readFile(context.paths.goals, "utf8"),
    ROADMAP_STATUS: formatStep(step),
    STEP_JSON: JSON.stringify(step, null, 2),
  });

  const provider = providerFor(context);
  const result = await provider.run({
    agent: "plan",
    context,
    logPath: path.join(logDir, "plan.opencode.log"),
    prompt,
    role: "plan",
  });
  await writeFile(path.join(logDir, "plan.prompt.md"), prompt);
  await writeFile(path.join(logDir, "plan.md"), result.output);

  return { logDir, result, step };
}

export async function run(context: ProjectContext, { maxSteps = 1 } = {}): Promise<number> {
  await ensureCleanWorktree(context);
  let completed = 0;

  while (completed < maxSteps) {
    const queueFile = await readQueue(context);
    const step = nextStep(queueFile);
    if (!step) return completed;

    const planResult = await plan(context);
    if (!planResult || planResult.result.code !== 0) throw new Error(`Planning failed for ${step.id}.`);

    const logDir = await createLogDir(context, step.id);
    const prompt = await renderPrompt(context, "implement-step.md", {
      GOALS_MD: await readFile(context.paths.goals, "utf8"),
      PLAN_MD: planResult.result.output,
      ROADMAP_STATUS: formatStep(step),
      STEP_JSON: JSON.stringify(step, null, 2),
    });
    await writeFile(path.join(logDir, "implement.prompt.md"), prompt);

    const provider = providerFor(context);
    const result = await provider.run({
      agent: "build",
      context,
      logPath: path.join(logDir, "implement.opencode.log"),
      prompt,
      role: "implement",
    });

    if (result.code !== 0) {
      markBlocked(queueFile, step.id, `Provider exited ${String(result.code)}`);
      await writeQueue(queueFile, context);
      throw new Error(`Implementation failed for ${step.id}.`);
    }

    const verification = await verify(context, step, logDir);
    if (!verification.ok) throw new Error(`Verification failed for ${step.id}.`);

    markDone(queueFile, step.id);
    await writeQueue(queueFile, context);
    completed += 1;
  }

  await cleanupProcesses(context);
  return completed;
}

export async function verify(context: ProjectContext, step: QueueStep, logDir: string): Promise<{ ok: boolean; output: string }> {
  let output = "";

  for (const [index, command] of step.verification.entries()) {
    const result = await runShell(context, command, path.join(logDir, `verify-${index + 1}.log`));
    output += `$ ${command}\n${result.output}\n`;
    if (result.code !== 0) return { ok: false, output };
  }

  return { ok: true, output };
}

function providerFor(context: ProjectContext): OpenCodeProvider {
  if (context.config.provider !== "opencode") throw new Error(`Unsupported provider: ${context.config.provider}`);
  return new OpenCodeProvider({ model: context.config.model ?? defaultModel, variant: context.config.variant ?? defaultVariant });
}

async function renderPrompt(context: ProjectContext, name: string, values: Record<string, string>): Promise<string> {
  const promptPath = path.join(context.paths.prompts, name);
  let template = await readFile(promptPath, "utf8");
  for (const [key, value] of Object.entries(values)) template = template.replaceAll(`{{${key}}}`, value);
  return template;
}

async function createLogDir(context: ProjectContext, name: string): Promise<string> {
  const timestamp = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
  const logDir = path.join(context.paths.logs, `${timestamp}-${name}`);
  await mkdir(logDir, { recursive: true });
  return logDir;
}

async function runShell(context: ProjectContext, command: string, logPath: string): Promise<{ code: number | null; output: string }> {
  await mkdir(path.dirname(logPath), { recursive: true });
  const child = spawn(command, [], { cwd: context.root, shell: true });
  let output = "";
  child.stdout.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });
  child.stderr.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });
  return new Promise((resolve) => {
    child.on("close", async (code: number | null) => {
      await writeFile(logPath, output);
      resolve({ code, output });
    });
  });
}

async function ensureCleanWorktree(context: ProjectContext): Promise<void> {
  const result = await runShell(context, "git status --short", path.join(context.paths.logs, "preflight-git-status.log"));
  if (result.output.trim() !== "") throw new Error("Roadrunner requires a clean git worktree.");
}
