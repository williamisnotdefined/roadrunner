import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import type { Stats } from "node:fs";
import { chmod, lstat, mkdir, readFile, readdir, readlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { defaultModel, defaultVariant, type ProjectContext } from "./config.js";
import { acquireProjectLock } from "./lock.js";
import {
  formatStep,
  goalsPathLabel,
  markBlocked,
  markDone,
  nextStep,
  normalizeQueueFile,
  readQueue,
  validateGoalsContent,
  validateQueueFile,
  writeQueue,
  type QueueFile,
  type QueueStep,
  type QueueValidationOptions,
} from "./queue.js";
import { cleanupProcesses, registerProcess, unregisterProcess } from "./process-registry.js";
import { OpenCodeProvider, validateOpenCodeCli, type ProviderRunResult, type ProviderStartEvent } from "./providers/opencode.js";

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
  | { type: "cleanup" }
  | { step: QueueStep; type: "fix" }
  | { step: QueueStep; type: "implement" }
  | { step: QueueStep; type: "plan" }
  | ({ step: QueueStep; type: "provider-start" } & ProviderStartEvent)
  | { step: QueueStep; type: "reconcile" }
  | { step: QueueStep; type: "step" }
  | { step: QueueStep; type: "step-complete" }
  | { attempt: "fixed" | "initial"; step: QueueStep; type: "verify" }
  | { type: "validate" };

interface RunSnapshot {
  goalsMarkdown: string;
}

const defaultVerificationTimeoutMs = 10 * 60 * 1000;
const defaultProviderTimeoutMs = 30 * 60 * 1000;
const forceKillDelayMs = 1_000;
const execFileAsync = promisify(execFile);
const fallbackFingerprintIgnoredDirectories = new Set([".git", "coverage", "dist", "node_modules", "test-output"]);

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
  const snapshot = await readRunSnapshot(context);
  const queueFile = await readValidatedQueue(context);
  const step = nextStep(queueFile);
  if (!step) return null;
  await ensureProviderAvailable(context);

  return planStep(context, step, snapshot, options);
}

export async function run(context: ProjectContext, options: RunOptions = {}): Promise<number> {
  const { maxHours, maxSteps = 1 } = options;
  const releaseLock = await acquireProjectLock(context);

  try {
    emitRunEvent(options, { type: "validate" });
    const snapshot = await readRunSnapshot(context);
    await validateProject(context);
    let completed = 0;
    let completedResult: number | undefined;
    const deadline = maxHours === undefined ? null : Date.now() + maxHours * 60 * 60 * 1000;

    let primaryError: unknown;
    let cleanupError: unknown;
    try {
      while (completed < maxSteps) {
        if (deadline !== null && Date.now() >= deadline) {
          completedResult = completed;
          break;
        }

        const queueFile = await readValidatedQueue(context);
        const step = nextStep(queueFile);
        if (!step) {
          completedResult = completed;
          break;
        }
        await ensureProviderAvailable(context);

        emitRunEvent(options, { step, type: "step" });
        emitRunEvent(options, { step, type: "plan" });
        const planResult = await planStep(context, step, snapshot, {
          deadline,
          onProviderStart: (event) => emitRunEvent(options, { ...event, step, type: "provider-start" }),
        });
        if (planResult.result.code !== 0) {
          await blockStep(context, queueFile, step, `Planning exited ${String(planResult.result.code)}`);
          throw new Error(`Planning failed for ${step.id} (exit ${String(planResult.result.code)}). See ${path.join(planResult.logDir, "plan.opencode.log")}.`);
        }

        const logDir = await createLogDir(context, step.id);
        const prompt = await renderPrompt(context, "implement-step.md", {
          GOALS_MD: snapshot.goalsMarkdown,
          PLAN_MD: planResult.result.output,
          ROADMAP_STATUS: formatStep(step),
          STEP_JSON: JSON.stringify(step, null, 2),
        });
        await writePrivateFile(path.join(logDir, "implement.prompt.md"), prompt);

        emitRunEvent(options, { step, type: "implement" });
        const result = await providerFor(context).run({
          agent: "build",
          context,
          env: providerEnvForDeadline(deadline),
          logPath: path.join(logDir, "implement.opencode.log"),
          onStart: (event) => emitRunEvent(options, { ...event, step, type: "provider-start" }),
          prompt,
          role: "implement",
          skipPermissions: context.config.dangerouslySkipPermissions,
        });

        if (result.code !== 0) {
          await blockStep(context, queueFile, step, `Provider exited ${String(result.code)}`);
          throw new Error(`Implementation failed for ${step.id}.`);
        }

        emitRunEvent(options, { attempt: "initial", step, type: "verify" });
        let verification = await verify(context, step, logDir, { deadline });
        if (!verification.ok) {
          emitRunEvent(options, { step, type: "fix" });
          const fix = await fixFailure(context, step, snapshot, planResult.result.output, verification.output, logDir, options, deadline);
          if (fix.code === 0) {
            emitRunEvent(options, { attempt: "fixed", step, type: "verify" });
            verification = await verify(context, step, logDir, { deadline, prefix: "verify-fixed" });
          }
        }

        if (!verification.ok) {
          await blockStep(context, queueFile, step, "Verification failed after fix attempt.");
          throw new Error(`Verification failed for ${step.id}.`);
        }

        emitRunEvent(options, { step, type: "reconcile" });
        try {
          const reconciledQueue = await reconcileQueue(context, step, snapshot, logDir, options, deadline);
          markDone(reconciledQueue, step.id);
          await writeQueue(reconciledQueue, context);
        } catch (error) {
          await blockStep(context, queueFile, step, `Reconciliation failed: ${(error as Error).message}`, { useLatest: false });
          throw error;
        }
        emitRunEvent(options, { step, type: "step-complete" });
        completed += 1;
      }

      completedResult ??= completed;
    } catch (error) {
      primaryError = error;
      throw error;
    } finally {
      emitRunEvent(options, { type: "cleanup" });
      try {
        await cleanupProcesses(context, { force: true });
      } catch (error) {
        if (primaryError === undefined) cleanupError = error;
      }
    }

    if (cleanupError !== undefined) throw cleanupError;
    return completedResult;
  } finally {
    await releaseLock();
  }
}

function emitRunEvent(options: RunOptions, event: RoadrunnerRunEvent): void {
  if (options.onEvent) options.onEvent(event);
}

async function planStep(
  context: ProjectContext,
  step: QueueStep,
  snapshot: RunSnapshot,
  options: PlanOptions,
): Promise<{ logDir: string; result: { code: number | null; output: string }; step: QueueStep }> {
  const logDir = await createLogDir(context, `${step.id}-plan`);
  const prompt = await renderPrompt(context, "plan-step.md", {
    GOALS_MD: snapshot.goalsMarkdown,
    ROADMAP_STATUS: formatStep(step),
    STEP_JSON: JSON.stringify(step, null, 2),
  });

  await writePrivateFile(path.join(logDir, "plan.prompt.md"), prompt);
  const beforePlanFingerprint = await projectMutationFingerprint(context);
  let result = await providerFor(context).run({
    agent: "plan",
    context,
    env: providerEnvForDeadline(options.deadline),
    logPath: path.join(logDir, "plan.opencode.log"),
    onStart: options.onProviderStart,
    prompt,
    role: "plan",
    skipPermissions: false,
  });

  const afterPlanFingerprint = await projectMutationFingerprint(context);
  if (beforePlanFingerprint !== null && afterPlanFingerprint !== null && beforePlanFingerprint !== afterPlanFingerprint) {
    const message = "Planning modified project files. Planning agents must be read-only.";
    result = { code: result.code === 0 ? 1 : result.code, output: `${result.output}${result.output.endsWith("\n") ? "" : "\n"}${message}\n` };
  }

  await writePrivateFile(path.join(logDir, "plan.md"), result.output);

  return { logDir, result, step };
}

async function readRunSnapshot(context: ProjectContext): Promise<RunSnapshot> {
  let goalsMarkdown = "";
  try {
    goalsMarkdown = await readFile(context.paths.goals, "utf8");
  } catch {
    throw new Error(`${goalsPathLabel(context)} must exist.`);
  }

  const errors = validateGoalsContent(context, goalsMarkdown);
  if (errors.length > 0) throw new Error(errors.join("\n"));
  return { goalsMarkdown };
}

async function validateProject(context: ProjectContext): Promise<void> {
  await readValidatedQueue(context);
}

async function readValidatedQueue(context: ProjectContext): Promise<QueueFile> {
  const queueFile = await readQueue(context);
  const errors = validateQueueFile(queueFile, queueValidationOptions(context));
  if (errors.length > 0) throw new Error(errors.join("\n"));
  return normalizeQueueFile(queueFile);
}

export async function verify(
  context: ProjectContext,
  step: QueueStep,
  logDir: string,
  { deadline = null, prefix = "verify" }: { deadline?: number | null; prefix?: string } = {},
): Promise<{ ok: boolean; output: string }> {
  let output = "";

  for (const [index, command] of step.verification.entries()) {
    const result = await runShell(context, command, path.join(logDir, `${prefix}-${index + 1}.log`), `${prefix}-${index + 1}`, verificationTimeoutMs(deadline));
    output += `$ ${command}\n${result.output}\n`;
    if (result.code !== 0) return { ok: false, output };
  }

  return { ok: true, output };
}

async function fixFailure(
  context: ProjectContext,
  step: QueueStep,
  snapshot: RunSnapshot,
  planMarkdown: string,
  failureOutput: string,
  logDir: string,
  options: RunOptions,
  deadline: number | null,
): Promise<ProviderRunResult> {
  const prompt = await renderPrompt(context, "fix-failure.md", {
    GOALS_MD: snapshot.goalsMarkdown,
    LAST_FAILURE: failureOutput,
    PLAN_MD: planMarkdown,
    STEP_JSON: JSON.stringify(step, null, 2),
  });
  await writePrivateFile(path.join(logDir, "fix-failure.prompt.md"), prompt);

  const result = await providerFor(context).run({
    agent: "build",
    context,
    env: providerEnvForDeadline(deadline),
    logPath: path.join(logDir, "fix-failure.opencode.log"),
    onStart: (event) => emitRunEvent(options, { ...event, step, type: "provider-start" }),
    prompt,
    role: "fix-failure",
    skipPermissions: context.config.dangerouslySkipPermissions,
  });
  await writePrivateFile(path.join(logDir, "fix-failure.md"), result.output);
  return result;
}

async function reconcileQueue(context: ProjectContext, step: QueueStep, snapshot: RunSnapshot, logDir: string, options: RunOptions, deadline: number | null): Promise<QueueFile> {
  const queueBeforeReconcile = await readValidatedQueue(context);
  const queueText = `${JSON.stringify(queueBeforeReconcile, null, 2)}\n`;

  const prompt = await renderPrompt(context, "reconcile-roadmap.md", {
    GOALS_MD: snapshot.goalsMarkdown,
    QUEUE_JSON: queueText,
  });
  await writePrivateFile(path.join(logDir, "reconcile.prompt.md"), prompt);

  const result = await providerFor(context).run({
    agent: "build",
    context,
    env: providerEnvForDeadline(deadline),
    logPath: path.join(logDir, "reconcile.opencode.log"),
    onStart: (event) => emitRunEvent(options, { ...event, step, type: "provider-start" }),
    prompt,
    role: "reconcile",
    skipPermissions: context.config.dangerouslySkipPermissions,
  });
  await writePrivateFile(path.join(logDir, "reconcile.md"), result.output);

  if (result.code !== 0) throw new Error(`Reconciliation failed for ${step.id}.`);

  const queueFile = await readQueue(context);
  const errors = validateQueueFile(queueFile, queueValidationOptions(context));
  if (errors.length > 0) throw new Error(errors.join("\n"));

  const normalizedQueueFile = normalizeQueueFile(queueFile);
  const preserveErrors = validateClosedRecordsPreserved(queueBeforeReconcile, normalizedQueueFile, step.id);
  if (preserveErrors.length > 0) throw new Error(preserveErrors.join("\n"));

  const reconciledQueueFile = restoreVerifiedCurrentStep(queueBeforeReconcile, normalizedQueueFile, step.id);
  const reconciledErrors = validateQueueFile(reconciledQueueFile, queueValidationOptions(context));
  if (reconciledErrors.length > 0) throw new Error(reconciledErrors.join("\n"));

  return reconciledQueueFile;
}

function restoreVerifiedCurrentStep(before: QueueFile, after: QueueFile, stepId: string): QueueFile {
  const verifiedStep = before.queue[0];
  if (!verifiedStep || verifiedStep.id !== stepId) throw new Error(`Reconciliation expected ${stepId} at queue[0].`);

  return {
    ...after,
    queue: [verifiedStep, ...after.queue.filter((step) => step.id !== stepId)],
    history: before.history,
    blocked: before.blocked,
  };
}

function providerFor(context: ProjectContext): OpenCodeProvider {
  return new OpenCodeProvider({ model: context.config.model ?? defaultModel, variant: context.config.variant ?? defaultVariant });
}

export async function validateProvider(context: ProjectContext): Promise<string[]> {
  if (context.config.provider !== "opencode") return [`Unsupported provider: ${context.config.provider}`];
  return validateOpenCodeCli();
}

async function ensureProviderAvailable(context: ProjectContext): Promise<void> {
  const errors = await validateProvider(context);
  if (errors.length > 0) throw new Error(errors.join("\n"));
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
  await mkdir(logDir, { mode: 0o700, recursive: true });
  await chmod(logDir, 0o700);
  return logDir;
}

async function writePrivateFile(filePath: string, content: string): Promise<void> {
  await writeFile(filePath, content, { mode: 0o600 });
  await chmod(filePath, 0o600);
}

async function blockStep(context: ProjectContext, queueFile: QueueFile, step: QueueStep, reason: string, { useLatest = true } = {}): Promise<void> {
  const blockedQueue = structuredClone(useLatest ? await queueForBlocking(context, queueFile, step) : queueFile);
  markBlocked(blockedQueue, step.id, reason);
  await writeQueue(blockedQueue, context);
}

async function queueForBlocking(context: ProjectContext, fallbackQueueFile: QueueFile, step: QueueStep): Promise<QueueFile> {
  try {
    const currentQueueFile = await readValidatedQueue(context);
    if (currentQueueFile.queue[0]?.id === step.id) return currentQueueFile;
  } catch {
    return fallbackQueueFile;
  }

  return fallbackQueueFile;
}

function providerEnvForDeadline(deadline: number | null | undefined): Record<string, string> {
  if (deadline === null || deadline === undefined) return {};
  const remaining = remainingDeadlineMs(deadline);
  const configured = parseNonNegativeIntegerEnv("ROADRUNNER_PROVIDER_TIMEOUT_MS", defaultProviderTimeoutMs);
  return { ROADRUNNER_PROVIDER_TIMEOUT_MS: String(configured === 0 ? remaining : Math.max(1, Math.min(configured, remaining))) };
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

async function runShell(context: ProjectContext, command: string, logPath: string, role: string, timeoutMs = 0): Promise<{ code: number | null; output: string }> {
  await mkdir(path.dirname(logPath), { recursive: true });
  const child = spawn(command, [], { cwd: context.root, detached: process.platform !== "win32", env: process.env, shell: true });
  let output = "";
  if (!child.pid) throw new Error("Failed to start shell process.");
  let registeredPid: number | null = child.pid;
  let registrationFailed = false;
  let timedOut = false;
  let timeout: NodeJS.Timeout | undefined;
  let killTimeout: NodeJS.Timeout | undefined;
  let forceKillDone: Promise<void> | undefined;
  let settled = false;
  const registrationDone = registerProcess({ command: [command], cwd: context.root, pid: child.pid, role }, context).catch((error: Error) => {
    registeredPid = null;
    if (settled) return;
    registrationFailed = true;
    output += `Failed to register shell process: ${error.message}\n`;
    signalProcessTree(child.pid, "SIGTERM");
    ({ done: forceKillDone, timeout: killTimeout } = scheduleProcessTreeKill(child.pid, (text) => {
      output += text;
    }));
  });

  if (timeoutMs > 0) {
    timeout = setTimeout(() => {
      timedOut = true;
      output += `Command timed out after ${timeoutMs} ms. Sending SIGTERM.\n`;
      signalProcessTree(child.pid, "SIGTERM");
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
    /* v8 ignore start -- shell spawn errors are defensive because commands run through the platform shell. */
    child.on("error", async (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (forceKillDone) await forceKillDone;
      else clearTimeout(killTimeout);
      output += `${error.message}\n`;
      await registrationDone;
      if (registeredPid !== null) await unregisterProcess(registeredPid, context);
      await writePrivateFile(logPath, output);
      resolve({ code: 1, output });
    });
    /* v8 ignore stop */
    child.on("close", async (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (forceKillDone) await forceKillDone;
      else clearTimeout(killTimeout);
      await registrationDone;
      if (registeredPid !== null) await unregisterProcess(registeredPid, context);
      await writePrivateFile(logPath, output);
      resolve({ code: registrationFailed ? 1 : timedOut ? 124 : code, output });
    });
  });
}

function signalProcessTree(pid: number | undefined, signal: NodeJS.Signals): void {
  if (!pid) return;
  try {
    process.kill(process.platform === "win32" ? pid : -pid, signal);
  } catch {
    /* Cleanup is best-effort after timeout or registration failure. */
  }
}

function scheduleProcessTreeKill(pid: number | undefined, appendOutput: (text: string) => void): { done: Promise<void>; timeout: NodeJS.Timeout } {
  let timeout: NodeJS.Timeout;
  const done = new Promise<void>((resolve) => {
    timeout = setTimeout(() => {
      appendOutput("Process did not exit after SIGTERM. Sending SIGKILL.\n");
      signalProcessTree(pid, "SIGKILL");
      resolve();
    }, forceKillDelayMs);
  });
  return { done, timeout: timeout! };
}

export function parseStatusPaths(output: string): string[] {
  if (output.includes("\0")) {
    const records = output.split("\0").filter((record) => record.length > 0);
    const paths: string[] = [];

    for (let index = 0; index < records.length; index += 1) {
      const record = records[index]!;
      const status = record.slice(0, 2);
      paths.push(record.slice(3));
      if (status.includes("R") || status.includes("C")) index += 1;
    }

    return paths;
  }

  return output
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0)
    .map((line) => {
      const value = line.slice(3);
      return value.includes(" -> ") ? value.split(" -> ").pop()! : value;
    });
}

function validateClosedRecordsPreserved(before: QueueFile, after: QueueFile, currentStepId: string): string[] {
  const errors: string[] = [];
  const afterHistory = after.history.filter((step) => step.id !== currentStepId);
  const afterBlocked = after.blocked.filter((step) => step.id !== currentStepId);
  if (JSON.stringify(afterHistory) !== JSON.stringify(before.history)) errors.push("Reconciliation must preserve history records.");
  if (JSON.stringify(afterBlocked) !== JSON.stringify(before.blocked)) errors.push("Reconciliation must preserve blocked records.");
  return errors;
}

export interface StatusEntry {
  path: string;
  status: string;
}

async function projectMutationFingerprint(context: ProjectContext): Promise<string | null> {
  const statusOutput = await gitStatusOutput(context);
  if (statusOutput === null) return filesystemMutationFingerprint(context);

  const entries = parseStatusEntries(statusOutput).filter((entry) => !isRoadrunnerRuntimePath(context, entry.path));
  const head = await gitHead(context);
  const fingerprints = await Promise.all(
    entries.map(async (entry) => ({
      path: entry.path,
      status: entry.status,
      content: await fileFingerprint(path.resolve(context.root, entry.path)),
    })),
  );

  return JSON.stringify({ head, fingerprints });
}

async function filesystemMutationFingerprint(context: ProjectContext): Promise<string> {
  const entries: Array<{ content?: string; path: string; target?: string; type: string }> = [];
  await collectFilesystemFingerprintEntries(context, context.root, entries);
  entries.sort((left, right) => left.path.localeCompare(right.path));
  return JSON.stringify({ entries, mode: "filesystem" });
}

async function collectFilesystemFingerprintEntries(context: ProjectContext, absolutePath: string, entries: Array<{ content?: string; path: string; target?: string; type: string }>): Promise<void> {
  const relativePath = path.relative(context.root, absolutePath).split(path.sep).join(path.posix.sep);
  if (relativePath.length > 0 && isIgnoredFilesystemFingerprintPath(context, relativePath, absolutePath)) return;

  let stat: Stats;
  try {
    stat = await lstat(absolutePath);
  } catch (error) {
    /* v8 ignore start -- lstat failures during traversal are filesystem races. */
    entries.push({ path: relativePath, type: `unreadable:${(error as NodeJS.ErrnoException).code ?? "unknown"}` });
    return;
    /* v8 ignore stop */
  }

  if (stat.isDirectory()) {
    let names: string[];
    try {
      names = await readdir(absolutePath);
    } catch (error) {
      /* v8 ignore start -- directory read failures during traversal are filesystem races. */
      entries.push({ path: relativePath, type: `unreadable-directory:${(error as NodeJS.ErrnoException).code ?? "unknown"}` });
      return;
      /* v8 ignore stop */
    }

    await Promise.all(names.sort().map((name) => collectFilesystemFingerprintEntries(context, path.join(absolutePath, name), entries)));
    return;
  }

  if (stat.isSymbolicLink()) {
    try {
      entries.push({ path: relativePath, target: await readlink(absolutePath), type: "symlink" });
    } catch (error) {
      /* v8 ignore next -- symlink read failures during traversal are filesystem races. */
      entries.push({ path: relativePath, type: `unreadable-symlink:${(error as NodeJS.ErrnoException).code ?? "unknown"}` });
    }
    return;
  }

  if (stat.isFile()) {
    entries.push({ content: await fileFingerprint(absolutePath), path: relativePath, type: "file" });
    return;
  }

  /* v8 ignore next -- special filesystem nodes are platform-specific and defensive. */
  entries.push({ path: relativePath, type: "other" });
}

async function gitStatusOutput(context: ProjectContext): Promise<string | null> {
  try {
    const result = await execFileAsync("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], { cwd: context.root, env: process.env, maxBuffer: 20 * 1024 * 1024 });
    return result.stdout;
  } catch {
    return null;
  }
}

async function gitHead(context: ProjectContext): Promise<string | null> {
  try {
    const result = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: context.root, env: process.env });
    return result.stdout.trim();
  } catch {
    return null;
  }
}

export function parseStatusEntries(output: string): StatusEntry[] {
  if (output.includes("\0")) {
    const records = output.split("\0").filter((record) => record.length > 0);
    const entries: StatusEntry[] = [];

    for (let index = 0; index < records.length; index += 1) {
      const record = records[index]!;
      const status = record.slice(0, 2);
      entries.push({ path: record.slice(3), status });
      if (status.includes("R") || status.includes("C")) index += 1;
    }

    return entries;
  }

  return output
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0)
    .map((line) => {
      const value = line.slice(3);
      return { path: value.includes(" -> ") ? value.split(" -> ").pop()! : value, status: line.slice(0, 2) };
    });
}

async function fileFingerprint(filePath: string): Promise<string> {
  try {
    return createHash("sha256").update(await readFile(filePath)).digest("hex");
  } catch (error) {
    return `unreadable:${(error as NodeJS.ErrnoException).code ?? "unknown"}`;
  }
}

function isRoadrunnerRuntimePath(context: ProjectContext, relativePath: string): boolean {
  const absolutePath = path.resolve(context.root, relativePath);
  return isSameOrInside(context.paths.logs, absolutePath) || absolutePath === context.paths.processRegistry || absolutePath === context.paths.lock;
}

function isIgnoredFilesystemFingerprintPath(context: ProjectContext, relativePath: string, absolutePath: string): boolean {
  if (isRoadrunnerRuntimePath(context, relativePath)) return true;
  return relativePath.split(path.posix.sep).some((segment) => fallbackFingerprintIgnoredDirectories.has(segment)) || isSameOrInside(path.join(context.root, ".roadrunner", "logs"), absolutePath);
}

function isSameOrInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative.length === 0 || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
