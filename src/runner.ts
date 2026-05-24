import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

import { defaultModel, defaultVariant, type ProjectContext } from "./config.js";
import { formatStep, markBlocked, markDone, nextStep, readQueue, validateGoals, validateQueueFile, writeQueue, type QueueStep } from "./queue.js";
import { cleanupProcesses } from "./process-registry.js";
import { OpenCodeProvider, type ProviderRunResult } from "./providers/opencode.js";

export interface RoadrunnerStatus {
  blocked: number;
  done: number;
  next: QueueStep | null;
  queued: number;
}

export interface RunOptions {
  maxHours?: number;
  maxSteps?: number;
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
    skipPermissions: false,
  });
  await writeFile(path.join(logDir, "plan.prompt.md"), prompt);
  await writeFile(path.join(logDir, "plan.md"), result.output);

  return { logDir, result, step };
}

export async function run(context: ProjectContext, { maxHours, maxSteps = 1 }: RunOptions = {}): Promise<number> {
  await ensureCleanWorktree(context);
  let completed = 0;
  const deadline = maxHours === undefined ? null : Date.now() + maxHours * 60 * 60 * 1000;

  try {
    while (completed < maxSteps) {
      if (deadline !== null && Date.now() >= deadline) return completed;

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

      let verification = await verify(context, step, logDir);
      if (!verification.ok) {
        const fix = await fixFailure(context, step, planResult.result.output, verification.output, logDir);
        if (fix.code === 0) verification = await verify(context, step, logDir, { prefix: "verify-fixed" });
      }

      if (!verification.ok) {
        markBlocked(queueFile, step.id, "Verification failed after fix attempt.");
        await writeQueue(queueFile, context);
        throw new Error(`Verification failed for ${step.id}.`);
      }

      markDone(queueFile, step.id);
      await writeQueue(queueFile, context);
      await commitCurrentChanges(context, step.commitMessage, logDir, "step-commit");
      await reconcileQueue(context, step, logDir);
      completed += 1;
    }

    return completed;
  } finally {
    await cleanupProcesses(context);
  }
}

export async function verify(context: ProjectContext, step: QueueStep, logDir: string, { prefix = "verify" } = {}): Promise<{ ok: boolean; output: string }> {
  let output = "";

  for (const [index, command] of step.verification.entries()) {
    const result = await runShell(context, command, path.join(logDir, `${prefix}-${index + 1}.log`));
    output += `$ ${command}\n${result.output}\n`;
    if (result.code !== 0) return { ok: false, output };
  }

  return { ok: true, output };
}

async function fixFailure(context: ProjectContext, step: QueueStep, planMarkdown: string, failureOutput: string, logDir: string): Promise<ProviderRunResult> {
  const prompt = await renderPrompt(context, "fix-failure.md", {
    GOALS_MD: await readFile(context.paths.goals, "utf8"),
    LAST_FAILURE: failureOutput,
    PLAN_MD: planMarkdown,
    STEP_JSON: JSON.stringify(step, null, 2),
  });
  await writeFile(path.join(logDir, "fix-failure.prompt.md"), prompt);

  const result = await providerFor(context).run({
    agent: "build",
    context,
    logPath: path.join(logDir, "fix-failure.opencode.log"),
    prompt,
    role: "fix-failure",
  });
  await writeFile(path.join(logDir, "fix-failure.md"), result.output);
  return result;
}

async function reconcileQueue(context: ProjectContext, step: QueueStep, logDir: string): Promise<void> {
  const prompt = await renderPrompt(context, "reconcile-roadmap.md", {
    GOALS_MD: await readFile(context.paths.goals, "utf8"),
    QUEUE_JSON: await readFile(context.paths.queue, "utf8"),
  });
  await writeFile(path.join(logDir, "reconcile.prompt.md"), prompt);

  const result = await providerFor(context).run({
    agent: "build",
    context,
    logPath: path.join(logDir, "reconcile.opencode.log"),
    prompt,
    role: "reconcile",
  });
  await writeFile(path.join(logDir, "reconcile.md"), result.output);

  if (result.code !== 0) throw new Error(`Reconciliation failed for ${step.id}.`);

  const changed = await changedFiles(context, path.join(logDir, "reconcile-git-status.log"));
  if (changed.length === 0) return;

  const queuePath = gitRelativePath(context, context.paths.queue);
  const disallowed = changed.filter((filePath) => filePath !== queuePath);
  if (disallowed.length > 0) throw new Error(`Reconciliation changed files outside ${queuePath}: ${disallowed.join(", ")}`);

  const queueFile = await readQueue(context);
  const errors = validateQueueFile(queueFile);
  if (errors.length > 0) throw new Error(errors.join("\n"));

  await commitCurrentChanges(context, `Reconcile Roadrunner queue after ${step.id}`, logDir, "reconcile-commit");
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
  if ((await changedFiles(context, path.join(context.paths.logs, "preflight-git-status.log"))).length > 0) throw new Error("Roadrunner requires a clean git worktree.");
}

async function commitCurrentChanges(context: ProjectContext, message: string, logDir: string, name: string): Promise<boolean> {
  const files = await changedFiles(context, path.join(logDir, `${name}-status.log`));
  /* v8 ignore next -- run normally mutates queue state before attempting a step commit. */
  if (files.length === 0) return false;

  const add = await runShell(context, ["git add -A --", ...files.map(shellQuote)].join(" "), path.join(logDir, `${name}-add.log`));
  if (add.code !== 0) throw new Error(`git add failed for ${name}: ${add.output.trim()}`);

  const commit = await runShell(context, `git commit -m ${shellQuote(message)}`, path.join(logDir, `${name}.log`));
  if (commit.code !== 0) throw new Error(`git commit failed for ${name}: ${commit.output.trim()}`);
  return true;
}

async function changedFiles(context: ProjectContext, logPath: string): Promise<string[]> {
  const result = await runShell(context, "git status --short", logPath);
  if (result.code !== 0) throw new Error("git status failed.");
  return parseStatusPaths(result.output).filter((filePath) => !isRuntimePath(context, filePath));
}

export function parseStatusPaths(output: string): string[] {
  return output
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0)
    .map((line) => {
      const value = line.slice(3);
      return value.includes(" -> ") ? value.split(" -> ").pop()! : value;
    });
}

function gitRelativePath(context: ProjectContext, filePath: string): string {
  return path.relative(context.root, filePath).split(path.sep).join(path.posix.sep);
}

function isRuntimePath(context: ProjectContext, filePath: string): boolean {
  const logs = `${gitRelativePath(context, context.paths.logs)}/`;
  return filePath.startsWith(logs) || filePath === gitRelativePath(context, context.paths.processRegistry) || filePath === gitRelativePath(context, context.paths.lock);
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
