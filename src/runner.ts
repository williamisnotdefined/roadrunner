import { chmod, mkdir, open, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";

import { defaultModel, defaultVariant, type ProjectContext } from "./config.js";
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
import { cleanupProcesses, registerProcess, unregisterProcess } from "./process-registry.js";
import { OpenCodeProvider, type ProviderRunInput, type ProviderRunResult, type ProviderStartEvent } from "./providers/opencode.js";

export interface RoadrunnerStatus {
  blocked: number;
  done: number;
  next: QueueStep | null;
  queued: number;
}

export interface RunOptions {
  maxHours?: number;
  maxSteps?: number;
  onEvent?: (event: RoadrunnerRunEvent) => void;
}

export interface PlanOptions {
  deadline?: number | null;
  onProviderStart?: (event: ProviderStartEvent) => void;
}

export type RoadrunnerRunEvent =
  | { type: "clean-worktree" }
  | { type: "cleanup" }
  | { step: QueueStep; type: "commit" }
  | { step: QueueStep; type: "fix" }
  | { step: QueueStep; type: "implement" }
  | { step: QueueStep; type: "plan" }
  | ({ step: QueueStep; type: "provider-start" } & ProviderStartEvent)
  | { step: QueueStep; type: "reconcile" }
  | { step: QueueStep; type: "step" }
  | { step: QueueStep; type: "step-complete" }
  | { attempt: "fixed" | "initial"; step: QueueStep; type: "verify" }
  | { type: "validate" };

interface GitStatusEntry {
  index: string;
  originalPath?: string;
  path: string;
  workTree: string;
}

interface GitBaseline {
  head: string;
  ref: string;
  refs: Record<string, string>;
}

const defaultVerificationTimeoutMs = 10 * 60 * 1000;
const forceKillDelayMs = 1_000;

class GitHistoryChangedError extends Error {}

export async function status(context: ProjectContext): Promise<RoadrunnerStatus> {
  const queueFile = await readValidatedQueue(context);

  return {
    blocked: queueFile.blocked.length,
    done: queueFile.history.length,
    next: nextStep(queueFile),
    queued: queueFile.queue.length,
  };
}

export async function plan(
  context: ProjectContext,
  options: PlanOptions = {},
): Promise<{ logDir: string; result: { code: number | null; output: string }; step: QueueStep } | null> {
  const queueFile = await readValidatedQueue(context);
  const step = nextStep(queueFile);
  if (!step) return null;
  await ensureCleanWorktree(context);

  const logDir = await createLogDir(context, `${step.id}-plan`);
  const prompt = await renderPrompt(context, "plan-step.md", {
    GOALS_MD: await readFile(context.paths.goals, "utf8"),
    ROADMAP_STATUS: formatStep(step),
    STEP_JSON: JSON.stringify(step, null, 2),
  });

  const provider = providerFor(context);
  await writeFile(path.join(logDir, "plan.prompt.md"), prompt);
  const result = await runProviderWithGitGuard({
    agent: "plan",
    context,
    env: providerEnvForDeadline(options.deadline),
    historyLabel: "Planning",
    logPath: path.join(logDir, "plan.opencode.log"),
    logDir,
    onStart: options.onProviderStart,
    prompt,
    provider,
    role: "plan",
    skipPermissions: false,
  });
  await writeFile(path.join(logDir, "plan.md"), result.output);

  const planChanges = await changedStatusEntries(context, path.join(logDir, "plan-git-status.log"));
  if (planChanges.length > 0) {
    await restoreChangedEntries(context, planChanges, path.join(logDir, "plan-restore.log"));
    throw new Error(`Planning changed files: ${statusEntryPaths(planChanges).join(", ")}`);
  }

  return { logDir, result, step };
}

export async function run(context: ProjectContext, options: RunOptions = {}): Promise<number> {
  const { maxHours, maxSteps = 1 } = options;
  const releaseLock = await acquireRunLock(context);

  try {
    emitRunEvent(options, { type: "validate" });
    await validateProject(context);
    emitRunEvent(options, { type: "clean-worktree" });
    await ensureCleanWorktree(context);
    let completed = 0;
    const deadline = maxHours === undefined ? null : Date.now() + maxHours * 60 * 60 * 1000;

    try {
      while (completed < maxSteps) {
        if (deadline !== null && Date.now() >= deadline) return completed;

        const queueFile = await readValidatedQueue(context);
        const step = nextStep(queueFile);
        if (!step) return completed;

        emitRunEvent(options, { step, type: "step" });
        emitRunEvent(options, { step, type: "plan" });
        const planResult = await plan(context, { deadline, onProviderStart: (event) => emitRunEvent(options, { ...event, step, type: "provider-start" }) });
        /* v8 ignore next -- plan can only return null here if the queue changes between validated reads. */
        if (!planResult) throw new Error(`Planning failed for ${step.id}.`);
        if (planResult.result.code !== 0) {
          await blockStepCleanly(context, queueFile, step, `Planning exited ${String(planResult.result.code)}`, planResult.logDir);
          throw new Error(`Planning failed for ${step.id} (exit ${String(planResult.result.code)}). See ${path.join(planResult.logDir, "plan.opencode.log")}.`);
        }
        /* v8 ignore next -- step mismatch requires an external queue race between validated reads. */
        if (planResult.step.id !== step.id) throw new Error(`Planning selected ${planResult.step.id}, expected ${step.id}.`);

        const logDir = await createLogDir(context, step.id);
        const prompt = await renderPrompt(context, "implement-step.md", {
          GOALS_MD: await readFile(context.paths.goals, "utf8"),
          PLAN_MD: planResult.result.output,
          ROADMAP_STATUS: formatStep(step),
          STEP_JSON: JSON.stringify(step, null, 2),
        });
        await writeFile(path.join(logDir, "implement.prompt.md"), prompt);

        emitRunEvent(options, { step, type: "implement" });
        const provider = providerFor(context);
        let result: ProviderRunResult;
        try {
          result = await runProviderWithGitGuard({
            agent: "build",
            context,
            env: providerEnvForDeadline(deadline),
            historyLabel: "Implementation",
            logPath: path.join(logDir, "implement.opencode.log"),
            logDir,
            onStart: (event) => emitRunEvent(options, { ...event, step, type: "provider-start" }),
            prompt,
            provider,
            role: "implement",
          });
        } catch (error) {
          /* v8 ignore next -- non-history implementation errors are rethrown without queue mutation. */
          if (error instanceof GitHistoryChangedError) await blockStepCleanly(context, queueFile, step, error.message, logDir);
          throw error;
        }

        if (result.code !== 0) {
          await blockStepCleanly(context, queueFile, step, `Provider exited ${String(result.code)}`, logDir);
          throw new Error(`Implementation failed for ${step.id}.`);
        }
        await ensureGoalsUnchangedOrBlock(context, queueFile, step, logDir, "implement-goals-status.log");

        emitRunEvent(options, { attempt: "initial", step, type: "verify" });
        let beforeVerify = await worktreeSnapshot(context, path.join(logDir, "verify-before"));
        let verification: { ok: boolean; output: string };
        try {
          verification = await verify(context, step, logDir, { deadline });
        } catch (error) {
          /* v8 ignore next -- non-history verification errors are rethrown without queue mutation. */
          if (error instanceof GitHistoryChangedError) await blockStepCleanly(context, queueFile, step, error.message, logDir);
          throw error;
        }
        await ensureGoalsUnchangedOrBlock(context, queueFile, step, logDir, "verify-goals-status.log");
        await ensureSnapshotUnchangedOrBlock(context, queueFile, step, logDir, beforeVerify, "verify-after", "Verification changed files.");
        if (!verification.ok) {
          emitRunEvent(options, { step, type: "fix" });
          let fix: ProviderRunResult;
          try {
            fix = await fixFailure(context, step, planResult.result.output, verification.output, logDir, options, deadline);
          } catch (error) {
            /* v8 ignore next -- non-history fix errors are rethrown without queue mutation. */
            if (error instanceof GitHistoryChangedError) await blockStepCleanly(context, queueFile, step, error.message, logDir);
            throw error;
          }
          await ensureGoalsUnchangedOrBlock(context, queueFile, step, logDir, "fix-failure-goals-status.log");
          if (fix.code === 0) {
            emitRunEvent(options, { attempt: "fixed", step, type: "verify" });
            beforeVerify = await worktreeSnapshot(context, path.join(logDir, "verify-fixed-before"));
            try {
              verification = await verify(context, step, logDir, { deadline, prefix: "verify-fixed" });
            } catch (error) {
              /* v8 ignore next -- non-history verification errors are rethrown without queue mutation. */
              if (error instanceof GitHistoryChangedError) await blockStepCleanly(context, queueFile, step, error.message, logDir);
              throw error;
            }
            await ensureGoalsUnchangedOrBlock(context, queueFile, step, logDir, "verify-fixed-goals-status.log");
            await ensureSnapshotUnchangedOrBlock(context, queueFile, step, logDir, beforeVerify, "verify-fixed-after", "Verification changed files.");
          }
        }

        if (!verification.ok) {
          await blockStepCleanly(context, queueFile, step, "Verification failed after fix attempt.", logDir);
          throw new Error(`Verification failed for ${step.id}.`);
        }

        emitRunEvent(options, { step, type: "commit" });
        try {
          const implementationCommitted = await commitStepImplementation(context, step, logDir);
          if (!implementationCommitted) {
            await blockStepCleanly(context, queueFile, step, "Implementation produced no project changes.", logDir);
            throw new Error(`Implementation produced no project changes for ${step.id}.`);
          }
        } catch (error) {
          if ((error as Error).message.startsWith("Implementation changed Roadrunner queue state directly"))
            await blockStepCleanly(context, queueFile, step, (error as Error).message, logDir);
          throw error;
        }
        emitRunEvent(options, { step, type: "reconcile" });
        try {
          const reconciledQueue = await reconcileQueue(context, step, logDir, options, deadline);
          markDone(reconciledQueue, step.id);
          await writeQueue(reconciledQueue, context);
          await commitCurrentChanges(context, `Complete Roadrunner step ${step.id}`, logDir, "queue-commit");
        } catch (error) {
          await restoreCurrentChanges(context, logDir, "queue-finalize-failure-restore");
          await blockStepAfterCommittedImplementation(context, step, `Reconciliation failed: ${(error as Error).message}`, logDir);
          throw error;
        }
        emitRunEvent(options, { step, type: "step-complete" });
        completed += 1;
      }

      return completed;
    } finally {
      emitRunEvent(options, { type: "cleanup" });
      await cleanupProcesses(context);
    }
  } finally {
    await releaseLock();
  }
}

function emitRunEvent(options: RunOptions, event: RoadrunnerRunEvent): void {
  if (options.onEvent) options.onEvent(event);
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

export async function verify(
  context: ProjectContext,
  step: QueueStep,
  logDir: string,
  { deadline = null, prefix = "verify" }: { deadline?: number | null; prefix?: string } = {},
): Promise<{ ok: boolean; output: string }> {
  let output = "";

  for (const [index, command] of step.verification.entries()) {
    const role = `${prefix}-${index + 1}`;
    const baseline = await readGitBaseline(context, logDir, `${role}-history-before`);
    const result = await runShell(context, command, path.join(logDir, `${role}.log`), {
      env: await gitGuardEnv(context, logDir, role),
      role,
      timeoutMs: verificationTimeoutMs(deadline),
    });
    await ensureGitBaselineUnchangedOrRestore(context, baseline, logDir, `${role}-history`, "Verification changed git history.");
    output += `$ ${command}\n${result.output}\n`;
    if (result.code !== 0) return { ok: false, output };
  }

  return { ok: true, output };
}

async function fixFailure(
  context: ProjectContext,
  step: QueueStep,
  planMarkdown: string,
  failureOutput: string,
  logDir: string,
  options: RunOptions,
  deadline: number | null,
): Promise<ProviderRunResult> {
  const prompt = await renderPrompt(context, "fix-failure.md", {
    GOALS_MD: await readFile(context.paths.goals, "utf8"),
    LAST_FAILURE: failureOutput,
    PLAN_MD: planMarkdown,
    STEP_JSON: JSON.stringify(step, null, 2),
  });
  await writeFile(path.join(logDir, "fix-failure.prompt.md"), prompt);

  const result = await runProviderWithGitGuard({
    agent: "build",
    context,
    env: providerEnvForDeadline(deadline),
    historyLabel: "Fix failure",
    logPath: path.join(logDir, "fix-failure.opencode.log"),
    logDir,
    onStart: (event) => emitRunEvent(options, { ...event, step, type: "provider-start" }),
    prompt,
    provider: providerFor(context),
    role: "fix-failure",
  });
  await writeFile(path.join(logDir, "fix-failure.md"), result.output);
  return result;
}

async function reconcileQueue(context: ProjectContext, step: QueueStep, logDir: string, options: RunOptions, deadline: number | null): Promise<QueueFile> {
  const preReconcileChanges = await changedStatusEntries(context, path.join(logDir, "reconcile-pre-status.log"));
  if (preReconcileChanges.length > 0) throw new Error(`Expected clean worktree before reconciliation: ${statusEntryPaths(preReconcileChanges).join(", ")}`);
  const queueText = await readFile(context.paths.queue, "utf8");
  const queueBeforeReconcile = JSON.parse(queueText) as QueueFile;

  const prompt = await renderPrompt(context, "reconcile-roadmap.md", {
    GOALS_MD: await readFile(context.paths.goals, "utf8"),
    QUEUE_JSON: queueText,
  });
  await writeFile(path.join(logDir, "reconcile.prompt.md"), prompt);

  const result = await runProviderWithGitGuard({
    agent: "build",
    context,
    env: providerEnvForDeadline(deadline),
    historyLabel: "Reconciliation",
    logPath: path.join(logDir, "reconcile.opencode.log"),
    logDir,
    onStart: (event) => emitRunEvent(options, { ...event, step, type: "provider-start" }),
    prompt,
    provider: providerFor(context),
    role: "reconcile",
  });
  await writeFile(path.join(logDir, "reconcile.md"), result.output);

  if (result.code !== 0) {
    await restoreCurrentChanges(context, logDir, "reconcile-failure-restore");
    throw new Error(`Reconciliation failed for ${step.id}.`);
  }

  const changed = await changedStatusEntries(context, path.join(logDir, "reconcile-git-status.log"));
  if (changed.length === 0) return readValidatedQueue(context);

  const queuePath = gitRelativePath(context, context.paths.queue);
  const disallowed = changed.filter((entry) => entry.path !== queuePath || entry.originalPath !== undefined);
  if (disallowed.length > 0) {
    await restoreChangedEntries(context, changed, path.join(logDir, "reconcile-disallowed-restore.log"));
    throw new Error(`Reconciliation changed files outside ${queuePath}: ${statusEntryPaths(disallowed).join(", ")}`);
  }

  const queueFile = await readQueue(context);
  const errors = [...validateQueueFile(queueFile, queueValidationOptions(context)), ...validateClosedRecordsPreserved(queueBeforeReconcile, queueFile)];
  if (errors.length > 0) {
    await restoreChangedEntries(context, changed, path.join(logDir, "reconcile-invalid-restore.log"));
    throw new Error(errors.join("\n"));
  }

  return queueFile;
}

function providerFor(context: ProjectContext): OpenCodeProvider {
  if (context.config.provider !== "opencode") throw new Error(`Unsupported provider: ${context.config.provider}`);
  return new OpenCodeProvider({ model: context.config.model ?? defaultModel, variant: context.config.variant ?? defaultVariant });
}

function queueValidationOptions(context: ProjectContext): QueueValidationOptions {
  return { model: context.config.model ?? defaultModel, variant: context.config.variant ?? defaultVariant };
}

async function runProviderWithGitGuard({ env = {}, historyLabel, logDir, provider, ...input }: ProviderRunInput & { historyLabel: string; logDir: string; provider: OpenCodeProvider }): Promise<ProviderRunResult> {
  const baseline = await readGitBaseline(input.context, logDir, `${gitLogSlug(historyLabel)}-history-before`);
  const result = await provider.run({ ...input, env: { ...env, ...(await gitGuardEnv(input.context, logDir, gitLogSlug(historyLabel))) } });
  await ensureGitBaselineUnchangedOrRestore(input.context, baseline, logDir, `${gitLogSlug(historyLabel)}-history`, `${historyLabel} changed git history.`);
  return result;
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

async function gitGuardEnv(context: ProjectContext, logDir: string, name: string): Promise<Record<string, string>> {
  const guardBin = await createGitGuardBin(context, logDir, name);
  /* v8 ignore next -- Node test/runtime environments always provide PATH, but keep the fallback safe. */
  const currentPath = process.env.PATH ?? "";
  /* v8 ignore next -- Node test/runtime environments always provide PATH, but keep the fallback safe. */
  return { PATH: currentPath.length > 0 ? `${guardBin}${path.delimiter}${currentPath}` : guardBin };
}

async function createGitGuardBin(context: ProjectContext, logDir: string, name: string): Promise<string> {
  const realGit = await realGitPath(context, path.join(logDir, `${name}-real-git.log`));
  const guardBin = path.join(logDir, `${name}-git-guard`);
  const guardPath = path.join(guardBin, "git");
  await mkdir(guardBin, { recursive: true });
  await writeFile(guardPath, gitGuardScript(realGit), { mode: 0o755 });
  await chmod(guardPath, 0o755);
  return guardBin;
}

async function realGitPath(context: ProjectContext, logPath: string): Promise<string> {
  const result = await runShell(context, "command -v git", logPath);
  /* v8 ignore next -- test and runtime environments require git before Roadrunner can run. */
  if (result.code !== 0 || result.output.trim().length === 0) throw new Error(`Cannot find git executable: ${result.output.trim()}`);
  return result.output.trim().split(/\r?\n/)[0]!;
}

/* v8 ignore start -- generated git guard code is exercised through subprocess behavior tests. */
function gitGuardScript(realGit: string): string {
  return `#!/usr/bin/env node
import { spawnSync } from "node:child_process";

const realGit = ${JSON.stringify(realGit)};
const args = process.argv.slice(2);
const commandsWithValue = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path", "--super-prefix"]);
const denied = new Set(["add", "am", "apply", "bisect", "branch", "checkout", "cherry-pick", "clean", "commit", "commit-tree", "fetch", "merge", "mv", "pull", "push", "rebase", "reset", "restore", "revert", "rm", "stash", "submodule", "switch", "tag", "update-index", "update-ref", "worktree"]);

let index = 0;
while (index < args.length) {
  const arg = args[index];
  if (!arg || arg === "--") {
    index += 1;
    break;
  }
  if (!arg.startsWith("-")) break;
  if (commandsWithValue.has(arg)) index += 2;
  else if (arg.startsWith("--git-dir=") || arg.startsWith("--work-tree=") || arg.startsWith("--namespace=") || arg.startsWith("--exec-path=")) index += 1;
  else index += 1;
}

const command = args[index] ?? "";
if (denied.has(command)) {
  console.error("Roadrunner blocked git " + command + ": agents and verification commands must not mutate git state.");
  process.exit(126);
}

const result = spawnSync(realGit, args, { stdio: "inherit" });
if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}
process.exit(result.status ?? 1);
`;
}
/* v8 ignore stop */

async function readGitBaseline(context: ProjectContext, logDir: string, name: string): Promise<GitBaseline> {
  const head = await runShell(context, "git rev-parse --verify HEAD", path.join(logDir, `${name}-head.log`));
  /* v8 ignore next -- preflight git repository validation fails before guarded phases in normal runs. */
  if (head.code !== 0) throw new Error(`git rev-parse failed: ${head.output.trim()}`);

  const ref = await runShell(context, "git symbolic-ref -q HEAD", path.join(logDir, `${name}-ref.log`));
  const refs = await runShell(context, "git for-each-ref --format='%(refname) %(objectname)' refs/heads refs/tags", path.join(logDir, `${name}-refs.log`));
  /* v8 ignore next -- for-each-ref failures indicate a broken git repository after preflight. */
  if (refs.code !== 0) throw new Error(`git for-each-ref failed: ${refs.output.trim()}`);

  return {
    head: head.output.trim(),
    ref: ref.code === 0 ? ref.output.trim() : "DETACHED",
    refs: parseGitRefs(refs.output),
  };
}

async function ensureGitBaselineUnchangedOrRestore(context: ProjectContext, baseline: GitBaseline, logDir: string, name: string, message: string): Promise<void> {
  const current = await readGitBaseline(context, logDir, `${name}-after`);
  if (gitBaselineEquals(baseline, current)) return;

  await saveGitHistoryViolation(context, baseline, current, logDir, name);
  await restoreGitBaseline(context, baseline, current, logDir, name);
  throw new GitHistoryChangedError(message);
}

async function saveGitHistoryViolation(context: ProjectContext, baseline: GitBaseline, current: GitBaseline, logDir: string, name: string): Promise<void> {
  await writeFile(path.join(logDir, `${name}-baseline.json`), `${JSON.stringify(baseline, null, 2)}\n`);
  await writeFile(path.join(logDir, `${name}-current.json`), `${JSON.stringify(current, null, 2)}\n`);
  await runShell(context, "git status --porcelain=v1 -z", path.join(logDir, `${name}-status.log`));
  await runShell(context, `git log --oneline --decorate ${shellQuote(baseline.head)}..HEAD`, path.join(logDir, `${name}-commits.log`));
  await runShell(context, `git diff --binary ${shellQuote(baseline.head)}..HEAD`, path.join(logDir, `${name}-diff.log`));
  await runShell(context, "git diff --binary", path.join(logDir, `${name}-worktree.diff`));
  await runShell(context, "git diff --cached --binary", path.join(logDir, `${name}-staged.diff`));
}

async function restoreGitBaseline(context: ProjectContext, baseline: GitBaseline, current: GitBaseline, logDir: string, name: string): Promise<void> {
  /* v8 ignore next -- requires an agent to delete the originally checked-out branch before the guard restores it. */
  if (current.refs[baseline.ref] === undefined && baseline.ref.startsWith("refs/heads/")) {
    await runShell(context, `git update-ref ${shellQuote(baseline.ref)} ${shellQuote(baseline.head)}`, path.join(logDir, `${name}-restore-create-current-ref.log`));
  }

  if (baseline.ref.startsWith("refs/heads/")) {
    await runShell(context, `git switch --force ${shellQuote(baseline.ref.slice("refs/heads/".length))}`, path.join(logDir, `${name}-restore-switch.log`));
  } else {
    /* v8 ignore next -- autonomous runs normally start on a branch; detached HEAD restore is defensive. */
    await runShell(context, `git checkout --force --detach ${shellQuote(baseline.head)}`, path.join(logDir, `${name}-restore-detach.log`));
  }

  await runShell(context, `git reset --hard ${shellQuote(baseline.head)}`, path.join(logDir, `${name}-restore-reset.log`));

  for (const ref of Object.keys(current.refs).sort()) {
    if (baseline.refs[ref] === undefined) await runShell(context, `git update-ref -d ${shellQuote(ref)}`, path.join(logDir, `${name}-restore-delete-${gitLogSlug(ref)}.log`));
  }

  for (const [ref, object] of Object.entries(baseline.refs).sort(([left], [right]) => left.localeCompare(right))) {
    if (ref !== baseline.ref && current.refs[ref] !== object) await runShell(context, `git update-ref ${shellQuote(ref)} ${shellQuote(object)}`, path.join(logDir, `${name}-restore-ref-${gitLogSlug(ref)}.log`));
  }
}

function parseGitRefs(output: string): Record<string, string> {
  const refs: Record<string, string> = {};
  for (const line of output.split(/\r?\n/)) {
    const [ref, object] = line.split(" ", 2);
    if (ref && object) refs[ref] = object;
  }
  return refs;
}

function gitBaselineEquals(left: GitBaseline, right: GitBaseline): boolean {
  return left.head === right.head && left.ref === right.ref && JSON.stringify(left.refs) === JSON.stringify(right.refs);
}

function gitLogSlug(value: string): string {
  const slug = value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  /* v8 ignore next -- guard log labels and git refs are non-empty in normal execution. */
  return slug || "git";
}

async function acquireRunLock(context: ProjectContext): Promise<() => Promise<void>> {
  await mkdir(path.dirname(context.paths.lock), { recursive: true });
  const lock = { pid: process.pid, startedAt: new Date().toISOString() };

  try {
    const handle = await open(context.paths.lock, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(lock, null, 2)}\n`);
    } finally {
      await handle.close();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST" || !(await removeStaleRunLock(context))) throw new Error(`Roadrunner run lock already exists at ${context.paths.lock}.`);
    return acquireRunLock(context);
  }

  let released = false;
  return async () => {
    /* v8 ignore next -- release is idempotent for defensive cleanup. */
    if (released) return;
    released = true;
    await rm(context.paths.lock, { force: true });
  };
}

async function removeStaleRunLock(context: ProjectContext): Promise<boolean> {
  try {
    const value = JSON.parse(await readFile(context.paths.lock, "utf8")) as { pid?: unknown };
    if (typeof value.pid !== "number" || processExists(value.pid)) return false;
    await rm(context.paths.lock, { force: true });
    return true;
  } catch {
    /* v8 ignore next -- corrupt locks are intentionally treated as active. */
    return false;
  }
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function providerEnvForDeadline(deadline: number | null | undefined): Record<string, string> {
  if (deadline === null || deadline === undefined) return {};
  const remaining = remainingDeadlineMs(deadline);
  const configured = parseNonNegativeIntegerEnv("ROADRUNNER_PROVIDER_TIMEOUT_MS", 0);
  return { ROADRUNNER_PROVIDER_TIMEOUT_MS: String(Math.max(1, Math.min(configured > 0 ? configured : remaining, remaining))) };
}

function verificationTimeoutMs(deadline: number | null | undefined): number {
  const configured = parseNonNegativeIntegerEnv("ROADRUNNER_VERIFY_TIMEOUT_MS", defaultVerificationTimeoutMs);
  if (deadline === null || deadline === undefined) return configured;
  const remaining = remainingDeadlineMs(deadline);
  if (configured === 0) return remaining;
  return Math.max(1, Math.min(configured, remaining));
}

function remainingDeadlineMs(deadline: number): number {
  const remaining = Math.floor(deadline - Date.now());
  if (remaining <= 0) throw new Error("Roadrunner deadline exceeded.");
  return remaining;
}

function parseNonNegativeIntegerEnv(name: string, defaultValue: number): number {
  const value = process.env[name];
  if (value === undefined) return defaultValue;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`${name} must be a non-negative integer, got ${value}.`);
  return parsed;
}

async function runShell(
  context: ProjectContext,
  command: string,
  logPath: string,
  { env = {}, role, timeoutMs = 0 }: { env?: Record<string, string>; role?: string; timeoutMs?: number } = {},
): Promise<{ code: number | null; output: string }> {
  await mkdir(path.dirname(logPath), { recursive: true });
  const child = spawn(command, [], { cwd: context.root, detached: process.platform !== "win32", env: { ...process.env, ...env }, shell: true });
  let output = "";
  let registeredPid: number | null = role && child.pid ? child.pid : null;
  let registrationFailed = false;
  let timedOut = false;
  let timeout: NodeJS.Timeout | undefined;
  let killTimeout: NodeJS.Timeout | undefined;
  let forceKillDone: Promise<void> | undefined;
  let settled = false;
  /* v8 ignore next 11 -- shell registration failures require a registry path race after provider startup. */
  const registrationDone =
    role && child.pid
      ? registerProcess({ command: [command], cwd: context.root, pid: child.pid, role }, context).catch((error: Error) => {
          registeredPid = null;
          if (settled) return;
          registrationFailed = true;
          output += `Failed to register shell process: ${error.message}\n`;
          signalProcessTree(child.pid, "SIGTERM");
          /* v8 ignore next 3 -- SIGKILL fallback only appends when a child ignores SIGTERM. */
          ({ done: forceKillDone, timeout: killTimeout } = scheduleProcessTreeKill(child.pid, (text) => {
            output += text;
          }));
        })
      : Promise.resolve();

  if (timeoutMs > 0) {
    timeout = setTimeout(() => {
      timedOut = true;
      output += `Command timed out after ${timeoutMs} ms. Sending SIGTERM.\n`;
      signalProcessTree(child.pid, "SIGTERM");
      /* v8 ignore next 3 -- SIGKILL fallback only appends when a child ignores SIGTERM. */
      ({ done: forceKillDone, timeout: killTimeout } = scheduleProcessTreeKill(child.pid, (text) => {
        output += text;
      }));
    }, timeoutMs);
  }

  child.stdout.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });
  child.stderr.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });
  return new Promise((resolve) => {
    /* v8 ignore next 11 -- shell spawn errors are platform-specific; command failures resolve through close. */
    child.on("error", async (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (forceKillDone) await forceKillDone;
      else clearTimeout(killTimeout);
      output += `${error.message}\n`;
      await registrationDone;
      if (registeredPid !== null) await unregisterProcess(registeredPid, context);
      await writeFile(logPath, output);
      resolve({ code: 1, output });
    });
    child.on("close", async (code: number | null) => {
      /* v8 ignore next -- close cannot run twice for the same child process. */
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (forceKillDone) await forceKillDone;
      else clearTimeout(killTimeout);
      await registrationDone;
      if (registeredPid !== null) await unregisterProcess(registeredPid, context);
      await writeFile(logPath, output);
      /* v8 ignore next -- shell registration failure is a defensive branch covered by provider tests. */
      resolve({ code: registrationFailed ? 1 : timedOut ? 124 : code, output });
    });
  });
}

function signalProcessTree(pid: number | undefined, signal: NodeJS.Signals): void {
  /* v8 ignore next -- callers only signal after successful spawns expose a pid. */
  if (!pid) return;
  /* v8 ignore start -- signaling failures are best-effort cleanup paths. */
  try {
    /* v8 ignore next -- Windows process-tree signaling is covered by platform branching at runtime. */
    process.kill(process.platform === "win32" ? pid : -pid, signal);
  } catch {
    /* Cleanup is best-effort after timeout or registration failure. */
  }
  /* v8 ignore stop */
}

function scheduleProcessTreeKill(pid: number | undefined, appendOutput: (text: string) => void): { done: Promise<void>; timeout: NodeJS.Timeout } {
  let timeout: NodeJS.Timeout;
  /* v8 ignore next 8 -- SIGKILL fallback only runs when a child ignores SIGTERM. */
  const done = new Promise<void>((resolve) => {
    timeout = setTimeout(() => {
      appendOutput("Process did not exit after SIGTERM. Sending SIGKILL.\n");
      signalProcessTree(pid, "SIGKILL");
      resolve();
    }, forceKillDelayMs);
  });
  return { done, timeout: timeout! };
}

async function ensureCleanWorktree(context: ProjectContext): Promise<void> {
  if ((await changedStatusEntries(context, path.join(context.paths.logs, "preflight-git-status.log"))).length > 0) throw new Error("Roadrunner requires a clean git worktree.");
}

async function commitStepImplementation(context: ProjectContext, step: QueueStep, logDir: string): Promise<boolean> {
  const entries = await changedStatusEntries(context, path.join(logDir, "step-commit-status.log"));
  if (entries.length === 0) return false;
  assertGoalsReadOnly(context, entries);
  assertQueueReadOnlyForImplementation(context, entries);
  return commitEntries(context, entries, step.commitMessage, logDir, "step-commit");
}

async function blockStepCleanly(context: ProjectContext, queueFile: QueueFile, step: QueueStep, reason: string, logDir: string): Promise<void> {
  await saveCurrentDiff(context, logDir, "blocked-changes");
  const entries = await changedStatusEntries(context, path.join(logDir, "block-pre-restore-status.log"));
  const queuePath = gitRelativePath(context, context.paths.queue);
  const nonQueueEntries = entries.filter((entry) => entry.path !== queuePath && entry.originalPath !== queuePath);
  if (nonQueueEntries.length > 0) await restoreChangedEntries(context, nonQueueEntries, path.join(logDir, "block-restore.log"));

  const blockedQueue = structuredClone(queueFile);
  markBlocked(blockedQueue, step.id, reason);
  await writeQueue(blockedQueue, context);
  await commitCurrentChanges(context, `Block Roadrunner step ${step.id}`, logDir, "block-step-commit");
}

async function blockStepAfterCommittedImplementation(context: ProjectContext, step: QueueStep, reason: string, logDir: string): Promise<void> {
  await blockStepCleanly(context, await readValidatedQueue(context), step, reason, logDir);
}

async function ensureGoalsUnchangedOrBlock(context: ProjectContext, queueFile: QueueFile, step: QueueStep, logDir: string, statusLogName: string): Promise<void> {
  try {
    await ensureGoalsUnchanged(context, path.join(logDir, statusLogName));
  } catch (error) {
    await blockStepCleanly(context, queueFile, step, (error as Error).message, logDir);
    throw error;
  }
}

async function ensureSnapshotUnchangedOrBlock(
  context: ProjectContext,
  queueFile: QueueFile,
  step: QueueStep,
  logDir: string,
  before: string,
  afterName: string,
  reason: string,
): Promise<void> {
  const after = await worktreeSnapshot(context, path.join(logDir, afterName));
  if (after === before) return;
  await blockStepCleanly(context, queueFile, step, reason, logDir);
  throw new Error(reason);
}

async function saveCurrentDiff(context: ProjectContext, logDir: string, name: string): Promise<void> {
  await runShell(context, "git diff --binary", path.join(logDir, `${name}.diff`));
  await runShell(context, "git diff --cached --binary", path.join(logDir, `${name}-staged.diff`));
}

async function worktreeSnapshot(context: ProjectContext, logPrefix: string): Promise<string> {
  const status = await changedStatusEntries(context, `${logPrefix}-status.log`);
  const diff = await runShell(context, "git diff --binary", `${logPrefix}-diff.log`);
  /* v8 ignore next -- git diff failures are surfaced defensively. */
  if (diff.code !== 0) throw new Error(`git diff failed: ${diff.output.trim()}`);
  const stagedDiff = await runShell(context, "git diff --cached --binary", `${logPrefix}-staged-diff.log`);
  /* v8 ignore next -- git diff --cached failures are surfaced defensively. */
  if (stagedDiff.code !== 0) throw new Error(`git diff --cached failed: ${stagedDiff.output.trim()}`);
  const untracked = await untrackedContentSnapshot(context, `${logPrefix}-untracked.log`);
  return JSON.stringify(status.sort((left, right) => statusEntryKey(left).localeCompare(statusEntryKey(right)))) + diff.output + stagedDiff.output + untracked;
}

async function untrackedContentSnapshot(context: ProjectContext, logPath: string): Promise<string> {
  const result = await runShell(context, "git ls-files --others --exclude-standard -z", logPath);
  /* v8 ignore next -- git ls-files failures are surfaced defensively. */
  if (result.code !== 0) throw new Error(`git ls-files failed: ${result.output.trim()}`);
  const files = result.output
    .split("\0")
    .filter((filePath) => filePath.length > 0 && !isRuntimePath(context, filePath))
    .sort();
  const hashes: Array<[string, string]> = [];

  for (const filePath of files) {
    try {
      const content = await readFile(path.join(context.root, filePath));
      hashes.push([filePath, createHash("sha256").update(content).digest("hex")]);
    } catch (error) {
      /* v8 ignore next -- untracked files can disappear between git ls-files and readFile. */
      hashes.push([filePath, `missing:${(error as NodeJS.ErrnoException).code ?? "unknown"}`]);
    }
  }

  return JSON.stringify(hashes);
}

async function commitCurrentChanges(context: ProjectContext, message: string, logDir: string, name: string): Promise<boolean> {
  const entries = await changedStatusEntries(context, path.join(logDir, `${name}-status.log`));
  /* v8 ignore next -- run normally mutates queue state before attempting a step commit. */
  if (entries.length === 0) return false;
  assertGoalsReadOnly(context, entries);
  return commitEntries(context, entries, message, logDir, name);
}

async function commitEntries(context: ProjectContext, entries: GitStatusEntry[], message: string, logDir: string, name: string): Promise<boolean> {
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

function assertQueueReadOnlyForImplementation(context: ProjectContext, entries: GitStatusEntry[]): void {
  const queuePath = gitRelativePath(context, context.paths.queue);
  const changedQueue = entries.filter((entry) => entry.path === queuePath || entry.originalPath === queuePath);
  if (changedQueue.length > 0) throw new Error(`Implementation changed Roadrunner queue state directly: ${statusEntryPaths(changedQueue).join(", ")}`);
}

function validateClosedRecordsPreserved(before: QueueFile, after: QueueFile): string[] {
  const errors: string[] = [];
  if (JSON.stringify(after.history) !== JSON.stringify(before.history)) errors.push("Reconciliation must preserve history records.");
  if (JSON.stringify(after.blocked) !== JSON.stringify(before.blocked)) errors.push("Reconciliation must preserve blocked records.");
  return errors;
}

function statusEntryKey(entry: GitStatusEntry): string {
  return [entry.index, entry.workTree, entry.path, entry.originalPath ?? ""].join("\0");
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
