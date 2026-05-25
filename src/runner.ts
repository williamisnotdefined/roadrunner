import { mkdir, open, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

import { defaultModel, defaultVariant, type ProjectContext } from "./config.js";
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
import { OpenCodeProvider, type ProviderRunResult, type ProviderStartEvent } from "./providers/opencode.js";

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
const forceKillDelayMs = 1_000;

export async function status(context: ProjectContext): Promise<RoadrunnerStatus> {
  await readRunSnapshot(context);
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

  return planStep(context, step, snapshot, options);
}

export async function run(context: ProjectContext, options: RunOptions = {}): Promise<number> {
  const { maxHours, maxSteps = 1 } = options;
  const releaseLock = await acquireRunLock(context);

  try {
    emitRunEvent(options, { type: "validate" });
    const snapshot = await readRunSnapshot(context);
    await validateProject(context);
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
        await writeFile(path.join(logDir, "implement.prompt.md"), prompt);

        emitRunEvent(options, { step, type: "implement" });
        const result = await providerFor(context).run({
          agent: "build",
          context,
          env: providerEnvForDeadline(deadline),
          logPath: path.join(logDir, "implement.opencode.log"),
          onStart: (event) => emitRunEvent(options, { ...event, step, type: "provider-start" }),
          prompt,
          role: "implement",
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
          await blockStep(context, queueFile, step, `Reconciliation failed: ${(error as Error).message}`);
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

  await writeFile(path.join(logDir, "plan.prompt.md"), prompt);
  const result = await providerFor(context).run({
    agent: "plan",
    context,
    env: providerEnvForDeadline(options.deadline),
    logPath: path.join(logDir, "plan.opencode.log"),
    onStart: options.onProviderStart,
    prompt,
    role: "plan",
    skipPermissions: false,
  });
  await writeFile(path.join(logDir, "plan.md"), result.output);

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
  await writeFile(path.join(logDir, "fix-failure.prompt.md"), prompt);

  const result = await providerFor(context).run({
    agent: "build",
    context,
    env: providerEnvForDeadline(deadline),
    logPath: path.join(logDir, "fix-failure.opencode.log"),
    onStart: (event) => emitRunEvent(options, { ...event, step, type: "provider-start" }),
    prompt,
    role: "fix-failure",
  });
  await writeFile(path.join(logDir, "fix-failure.md"), result.output);
  return result;
}

async function reconcileQueue(context: ProjectContext, step: QueueStep, snapshot: RunSnapshot, logDir: string, options: RunOptions, deadline: number | null): Promise<QueueFile> {
  const queueBeforeReconcile = await readValidatedQueue(context);
  const queueText = `${JSON.stringify(queueBeforeReconcile, null, 2)}\n`;

  const prompt = await renderPrompt(context, "reconcile-roadmap.md", {
    GOALS_MD: snapshot.goalsMarkdown,
    QUEUE_JSON: queueText,
  });
  await writeFile(path.join(logDir, "reconcile.prompt.md"), prompt);

  const result = await providerFor(context).run({
    agent: "build",
    context,
    env: providerEnvForDeadline(deadline),
    logPath: path.join(logDir, "reconcile.opencode.log"),
    onStart: (event) => emitRunEvent(options, { ...event, step, type: "provider-start" }),
    prompt,
    role: "reconcile",
  });
  await writeFile(path.join(logDir, "reconcile.md"), result.output);

  if (result.code !== 0) throw new Error(`Reconciliation failed for ${step.id}.`);

  const queueFile = await readQueue(context);
  const errors = validateQueueFile(queueFile, queueValidationOptions(context));
  if (errors.length > 0) throw new Error(errors.join("\n"));

  const normalizedQueueFile = normalizeQueueFile(queueFile);
  const preserveErrors = validateClosedRecordsPreserved(queueBeforeReconcile, normalizedQueueFile);
  if (preserveErrors.length > 0) throw new Error(preserveErrors.join("\n"));

  return normalizedQueueFile;
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

async function blockStep(context: ProjectContext, queueFile: QueueFile, step: QueueStep, reason: string): Promise<void> {
  const blockedQueue = structuredClone(queueFile);
  markBlocked(blockedQueue, step.id, reason);
  await writeQueue(blockedQueue, context);
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

async function runShell(context: ProjectContext, command: string, logPath: string, role: string, timeoutMs = 0): Promise<{ code: number | null; output: string }> {
  await mkdir(path.dirname(logPath), { recursive: true });
  const child = spawn(command, [], { cwd: context.root, detached: process.platform !== "win32", env: process.env, shell: true });
  let output = "";
  /* v8 ignore next -- successful shell spawns expose a pid before close/error handling. */
  if (!child.pid) throw new Error("Failed to start shell process.");
  let registeredPid: number | null = child.pid;
  let registrationFailed = false;
  let timedOut = false;
  let timeout: NodeJS.Timeout | undefined;
  let killTimeout: NodeJS.Timeout | undefined;
  let forceKillDone: Promise<void> | undefined;
  let settled = false;
  /* v8 ignore start -- registration failures and pidless shell spawns are defensive process-management paths. */
  const registrationDone = registerProcess({ command: [command], cwd: context.root, pid: child.pid, role }, context).catch((error: Error) => {
    registeredPid = null;
    if (settled) return;
    registrationFailed = true;
    output += `Failed to register shell process: ${error.message}\n`;
    signalProcessTree(child.pid, "SIGTERM");
    /* v8 ignore next 3 -- SIGKILL fallback only appends when a child ignores SIGTERM. */
    ({ done: forceKillDone, timeout: killTimeout } = scheduleProcessTreeKill(child.pid, (text) => {
      output += text;
    }));
  });
  /* v8 ignore stop */

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
      /* v8 ignore next -- spawn errors before pid registration are platform-specific. */
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
      /* v8 ignore next -- successful shell commands normally have a registered pid before close. */
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

function validateClosedRecordsPreserved(before: QueueFile, after: QueueFile): string[] {
  const errors: string[] = [];
  if (JSON.stringify(after.history) !== JSON.stringify(before.history)) errors.push("Reconciliation must preserve history records.");
  if (JSON.stringify(after.blocked) !== JSON.stringify(before.blocked)) errors.push("Reconciliation must preserve blocked records.");
  return errors;
}
