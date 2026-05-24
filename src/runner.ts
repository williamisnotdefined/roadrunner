import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

import { defaultModel, defaultVariant, type ProjectContext, writeJson } from "./config.js";
import {
  formatStep,
  markBlocked,
  markDone,
  nextStep,
  readQueue,
  validateGoals,
  validateQueueFile,
  writeQueue,
  type QueueFile,
  type QueueStep,
  type QueueValidationOptions,
} from "./queue.js";
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

interface GitStatusEntry {
  index: string;
  originalPath?: string;
  path: string;
  workTree: string;
}

export async function status(context: ProjectContext): Promise<RoadrunnerStatus> {
  const queueFile = await readValidatedQueue(context);

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
  await validateProject(context);
  await ensureCleanWorktree(context);
  let completed = 0;
  const deadline = maxHours === undefined ? null : Date.now() + maxHours * 60 * 60 * 1000;

  try {
    while (completed < maxSteps) {
      if (deadline !== null && Date.now() >= deadline) return completed;

      const queueFile = await readValidatedQueue(context);
      const step = nextStep(queueFile);
      if (!step) return completed;

      const planResult = await plan(context);
      /* v8 ignore next -- plan can only return null here if the queue changes between validated reads. */
      if (!planResult) throw new Error(`Planning failed for ${step.id}.`);
      if (planResult.result.code !== 0) throw new Error(`Planning failed for ${step.id}.`);
      /* v8 ignore next -- step mismatch requires an external queue race between validated reads. */
      if (planResult.step.id !== step.id) throw new Error(`Planning selected ${planResult.step.id}, expected ${step.id}.`);

      const planChanges = await changedStatusEntries(context, path.join(planResult.logDir, "plan-git-status.log"));
      if (planChanges.length > 0) throw new Error(`Planning changed files: ${statusEntryPaths(planChanges).join(", ")}`);

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
        await ensureGoalsUnchanged(context, path.join(logDir, "implement-goals-status.log"));
        markBlocked(queueFile, step.id, `Provider exited ${String(result.code)}`);
        await writeQueue(queueFile, context);
        throw new Error(`Implementation failed for ${step.id}.`);
      }
      await ensureGoalsUnchanged(context, path.join(logDir, "implement-goals-status.log"));

      let verification = await verify(context, step, logDir);
      await ensureGoalsUnchanged(context, path.join(logDir, "verify-goals-status.log"));
      if (!verification.ok) {
        const fix = await fixFailure(context, step, planResult.result.output, verification.output, logDir);
        await ensureGoalsUnchanged(context, path.join(logDir, "fix-failure-goals-status.log"));
        if (fix.code === 0) {
          verification = await verify(context, step, logDir, { prefix: "verify-fixed" });
          await ensureGoalsUnchanged(context, path.join(logDir, "verify-fixed-goals-status.log"));
        }
      }

      if (!verification.ok) {
        markBlocked(queueFile, step.id, "Verification failed after fix attempt.");
        await writeQueue(queueFile, context);
        throw new Error(`Verification failed for ${step.id}.`);
      }

      await completeStepAndCommit(context, queueFile, step, logDir);
      await reconcileQueue(context, step, logDir);
      completed += 1;
    }

    return completed;
  } finally {
    await cleanupProcesses(context);
  }
}

async function validateProject(context: ProjectContext): Promise<void> {
  await readValidatedQueue(context);
}

async function readValidatedQueue(context: ProjectContext): Promise<QueueFile> {
  const queueFile = await readQueue(context);
  const errors = [...(await validateGoals(context)), ...validateQueueFile(queueFile, queueValidationOptions(context))];
  if (errors.length > 0) throw new Error(errors.join("\n"));
  return queueFile;
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
  const preReconcileChanges = await changedStatusEntries(context, path.join(logDir, "reconcile-pre-status.log"));
  if (preReconcileChanges.length > 0) throw new Error(`Expected clean worktree before reconciliation: ${statusEntryPaths(preReconcileChanges).join(", ")}`);

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

  if (result.code !== 0) {
    await restoreCurrentChanges(context, logDir, "reconcile-failure-restore");
    throw new Error(`Reconciliation failed for ${step.id}.`);
  }

  const changed = await changedStatusEntries(context, path.join(logDir, "reconcile-git-status.log"));
  if (changed.length === 0) return;

  const queuePath = gitRelativePath(context, context.paths.queue);
  const disallowed = changed.filter((entry) => entry.path !== queuePath || entry.originalPath !== undefined);
  if (disallowed.length > 0) {
    await restoreChangedEntries(context, changed, path.join(logDir, "reconcile-disallowed-restore.log"));
    throw new Error(`Reconciliation changed files outside ${queuePath}: ${statusEntryPaths(disallowed).join(", ")}`);
  }

  const queueFile = await readQueue(context);
  const errors = validateQueueFile(queueFile, queueValidationOptions(context));
  if (errors.length > 0) {
    await restoreChangedEntries(context, changed, path.join(logDir, "reconcile-invalid-restore.log"));
    throw new Error(errors.join("\n"));
  }

  try {
    await commitCurrentChanges(context, `Reconcile Roadrunner queue after ${step.id}`, logDir, "reconcile-commit");
  } catch (error) {
    await restoreChangedEntries(context, changed, path.join(logDir, "reconcile-commit-restore.log"));
    throw error;
  }
}

function providerFor(context: ProjectContext): OpenCodeProvider {
  if (context.config.provider !== "opencode") throw new Error(`Unsupported provider: ${context.config.provider}`);
  return new OpenCodeProvider({ model: context.config.model ?? defaultModel, variant: context.config.variant ?? defaultVariant });
}

function queueValidationOptions(context: ProjectContext): QueueValidationOptions {
  return { model: context.config.model ?? defaultModel, variant: context.config.variant ?? defaultVariant };
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
  if ((await changedStatusEntries(context, path.join(context.paths.logs, "preflight-git-status.log"))).length > 0) throw new Error("Roadrunner requires a clean git worktree.");
}

async function completeStepAndCommit(context: ProjectContext, queueFile: QueueFile, step: QueueStep, logDir: string): Promise<void> {
  const originalQueueFile = structuredClone(queueFile);
  markDone(queueFile, step.id);
  await writeQueue(queueFile, context);

  try {
    await commitCurrentChanges(context, step.commitMessage, logDir, "step-commit");
  } catch (error) {
    await rollbackQueueFile(context, originalQueueFile, logDir, "step-commit-rollback");
    throw error;
  }
}

async function rollbackQueueFile(context: ProjectContext, queueFile: QueueFile, logDir: string, name: string): Promise<void> {
  await writeJson(context.paths.queue, queueFile);
  await runShell(context, ["git add -A --", shellQuote(gitRelativePath(context, context.paths.queue))].join(" "), path.join(logDir, `${name}-add.log`));
}

async function commitCurrentChanges(context: ProjectContext, message: string, logDir: string, name: string): Promise<boolean> {
  const entries = await changedStatusEntries(context, path.join(logDir, `${name}-status.log`));
  /* v8 ignore next -- run normally mutates queue state before attempting a step commit. */
  if (entries.length === 0) return false;
  assertGoalsReadOnly(context, entries);

  const add = await runShell(context, ["git add -A --", ...pathspecsForEntries(entries).map(shellQuote)].join(" "), path.join(logDir, `${name}-add.log`));
  if (add.code !== 0) throw new Error(`git add failed for ${name}: ${add.output.trim()}`);

  const commit = await runShell(context, `git commit -m ${shellQuote(message)}`, path.join(logDir, `${name}.log`));
  if (commit.code !== 0) throw new Error(`git commit failed for ${name}: ${commit.output.trim()}`);
  return true;
}

async function ensureGoalsUnchanged(context: ProjectContext, logPath: string): Promise<void> {
  assertGoalsReadOnly(context, await changedStatusEntries(context, logPath));
}

async function restoreCurrentChanges(context: ProjectContext, logDir: string, name: string): Promise<void> {
  const entries = await changedStatusEntries(context, path.join(logDir, `${name}-status.log`));
  if (entries.length === 0) return;
  await restoreChangedEntries(context, entries, path.join(logDir, `${name}.log`));
}

async function restoreChangedEntries(context: ProjectContext, entries: GitStatusEntry[], logPath: string): Promise<void> {
  const tracked = entries.filter((entry) => entry.index !== "?" || entry.workTree !== "?");
  const untracked = entries.filter((entry) => entry.index === "?" && entry.workTree === "?");

  const trackedPathspecs = pathspecsForEntries(tracked);
  if (trackedPathspecs.length > 0) await runShell(context, ["git restore --staged --worktree --", ...trackedPathspecs.map(shellQuote)].join(" "), logPath);

  for (const entry of untracked) await rm(path.join(context.root, entry.path), { force: true, recursive: true });
}

async function changedStatusEntries(context: ProjectContext, logPath: string): Promise<GitStatusEntry[]> {
  const result = await runShell(context, "git status --porcelain=v1 -z", logPath);
  if (result.code !== 0) throw new Error("git status failed.");
  return parseStatusEntries(result.output).filter((entry) => !isRuntimeStatusEntry(context, entry));
}

export function parseStatusPaths(output: string): string[] {
  if (output.includes("\0")) return parseStatusEntries(output).map((entry) => entry.path);

  return output
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0)
    .map((line) => {
      const value = line.slice(3);
      return value.includes(" -> ") ? value.split(" -> ").pop()! : value;
    });
}

function parseStatusEntries(output: string): GitStatusEntry[] {
  const records = output.split("\0").filter((record) => record.length > 0);
  const entries: GitStatusEntry[] = [];

  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]!;
    const status = record.slice(0, 2);
    const entry: GitStatusEntry = { index: status[0]!, path: record.slice(3), workTree: status[1]! };

    if (status.includes("R") || status.includes("C")) entry.originalPath = records[++index];
    entries.push(entry);
  }

  return entries;
}

function gitRelativePath(context: ProjectContext, filePath: string): string {
  return path.relative(context.root, filePath).split(path.sep).join(path.posix.sep);
}

function isRuntimePath(context: ProjectContext, filePath: string): boolean {
  const logs = `${gitRelativePath(context, context.paths.logs)}/`;
  return filePath.startsWith(logs) || filePath === gitRelativePath(context, context.paths.processRegistry) || filePath === gitRelativePath(context, context.paths.lock);
}

function isRuntimeStatusEntry(context: ProjectContext, entry: GitStatusEntry): boolean {
  /* v8 ignore next -- runtime renames are defensive; runtime files are normally gitignored. */
  return isRuntimePath(context, entry.path) && (entry.originalPath === undefined || isRuntimePath(context, entry.originalPath));
}

function assertGoalsReadOnly(context: ProjectContext, entries: GitStatusEntry[]): void {
  const goalsPath = gitRelativePath(context, context.paths.goals);
  const changedGoals = entries.filter((entry) => entry.path === goalsPath || entry.originalPath === goalsPath);
  if (changedGoals.length > 0) throw new Error(`GOALS.md is read-only during Roadrunner runs: ${statusEntryPaths(changedGoals).join(", ")}`);
}

function pathspecsForEntries(entries: GitStatusEntry[]): string[] {
  return [...new Set(entries.flatMap((entry) => [entry.path, entry.originalPath]).filter((filePath): filePath is string => Boolean(filePath)))];
}

function statusEntryPaths(entries: GitStatusEntry[]): string[] {
  return pathspecsForEntries(entries);
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
