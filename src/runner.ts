import type { ProjectContext } from "./config.js";
import { acquireProjectLock } from "./lock.js";
import { nextStep, type QueueStep } from "./queue.js";
import { readValidatedQueue } from "./queue-service.js";
import { cleanupProcesses } from "./process-registry.js";
import { validateConfiguredProvider, type ProviderStartEvent } from "./providers/index.js";
import { readRunSnapshot } from "./run-snapshot.js";
import { planStep, type PlanOptions } from "./runner-planning.js";
import { createRunControl, runStepWithRestarts, type RunControlState } from "./runner-execution.js";

export type { PlanOptions } from "./runner-planning.js";
export { verify } from "./runner-verification.js";

export interface RoadrunnerStatus {
  blocked: number;
  done: number;
  next: QueueStep | null;
  queued: number;
}

export interface RunOptions {
  maxHours?: number;
  maxSteps?: number;
  onActivity?: (event: RoadrunnerRunActivityEvent) => void;
  onControl?: (control: RoadrunnerRunControl) => void;
  onEvent?: (event: RoadrunnerRunEvent) => void;
}

export type RoadrunnerRunPhase = "plan" | "implement" | "verify" | "fix" | "verify-fixed" | "reconcile";

export interface RoadrunnerRunActivityEvent {
  phase: RoadrunnerRunPhase;
  step: QueueStep;
}

export interface RoadrunnerRunControl {
  restartCurrentTask(): boolean;
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
  | { attempt: number; step: QueueStep; type: "task-restart" }
  | { elapsedMs: number; phase: RoadrunnerRunPhase | null; step: QueueStep; type: "task-restart-requested" }
  | { attempt: "fixed" | "initial"; step: QueueStep; type: "verify" }
  | { type: "validate" };

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
  const controlState: RunControlState = { current: null };
  options.onControl?.(createRunControl(controlState, (event) => emitRunEvent(options, event)));

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
        await runStepWithRestarts({
          context,
          controlState,
          deadline,
          emitActivity: (event) => emitRunActivity(options, event),
          emitEvent: (event) => emitRunEvent(options, event),
          queueFile,
          snapshot,
          step,
        });
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

function emitRunActivity(options: RunOptions, event: RoadrunnerRunActivityEvent): void {
  if (options.onActivity) options.onActivity(event);
}

function emitRunEvent(options: RunOptions, event: RoadrunnerRunEvent): void {
  if (options.onEvent) options.onEvent(event);
}

async function validateProject(context: ProjectContext): Promise<void> {
  await readValidatedQueue(context);
}

export async function validateProvider(context: ProjectContext): Promise<string[]> {
  return validateConfiguredProvider(context);
}

async function ensureProviderAvailable(context: ProjectContext): Promise<void> {
  const errors = await validateProvider(context);
  if (errors.length > 0) throw new Error(errors.join("\n"));
}
