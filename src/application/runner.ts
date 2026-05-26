import type { ProjectContext } from "../infrastructure/config.js";
import { acquireProjectLock } from "../infrastructure/lock.js";
import { nextStep, type QueueFile, type QueueStep } from "../domain/queue.js";
import { cleanupProcesses } from "../infrastructure/process-registry.js";
import { validateConfiguredProvider, type ProviderStartEvent } from "../infrastructure/providers/index.js";
import { readRunSnapshot } from "./run-snapshot.js";
import { planStep, type PlanOptions, type PlanStepResult } from "./runner-planning.js";
import { createRunControl, type RunControlState } from "./runner-control.js";
import { isRunStopRequested, RunStopRequested, runStepWithRestarts } from "./runner-execution.js";
import { reconcileQueue } from "./runner-reconciliation.js";
import { refreshQueueAtRunStart, seedQueueAtRunStart } from "./runner-startup.js";

export type { PlanOptions } from "./runner-planning.js";
export { verify } from "./runner-verification.js";

export interface RoadrunnerStatus {
  blocked: number;
  done: number;
  next: QueueStep | null;
  queued: number;
}

export interface RunOptions {
  initialQueueFile?: QueueFile | null;
  maxHours?: number;
  maxSteps?: number;
  onActivity?: (event: RoadrunnerRunActivityEvent) => void;
  onControl?: (control: RoadrunnerRunControl) => void;
  onEvent?: (event: RoadrunnerRunEvent) => void;
  operatorDirective?: string | null;
  streamProviderOutput?: boolean;
}

export type RoadrunnerRunPhase = "startup-refresh" | "plan" | "implement" | "verify" | "fix" | "verify-fixed" | "reconcile";

export interface RoadrunnerRunActivityEvent {
  phase: RoadrunnerRunPhase;
  step?: QueueStep;
}

export interface RoadrunnerRunControl {
  restartCurrentTask(): boolean;
  stopRun(): boolean;
}

export type RoadrunnerRunEvent =
  | { type: "cleanup" }
  | { step: QueueStep; type: "fix" }
  | { step: QueueStep; type: "implement" }
  | { step: QueueStep; type: "plan" }
  | ({ step?: QueueStep; type: "provider-start" } & ProviderStartEvent)
  | { queueFile: QueueFile; type: "queue-updated" }
  | { step: QueueStep; type: "reconcile" }
  | { step: QueueStep; type: "step" }
  | { step: QueueStep; type: "step-complete" }
  | { type: "run-stop-requested" }
  | { type: "startup-refresh" }
  | { idleMs: number; maxRestarts: number; phase: RoadrunnerRunPhase | null; restart: number; step: QueueStep; type: "task-auto-restart-requested" }
  | { idleMs: number; maxRestarts: number; phase: RoadrunnerRunPhase | null; step: QueueStep; type: "task-auto-restart-limit-exceeded" }
  | { attempt: number; step: QueueStep; type: "task-restart" }
  | { elapsedMs: number; phase: RoadrunnerRunPhase | null; step: QueueStep; type: "task-restart-requested" }
  | { attempt: "fixed" | "initial"; step: QueueStep; type: "verify" }
  | { type: "validate" };

export async function status(context: ProjectContext): Promise<RoadrunnerStatus> {
  const queueFile = await seedQueueAtRunStart(context);

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
): Promise<PlanStepResult | null> {
  const releaseLock = await acquireProjectLock(context, "Roadrunner plan");
  try {
    const snapshot = await readRunSnapshot(context, { operatorDirective: options.operatorDirective });
    await ensureProviderAvailable(context);
    const startup = await refreshQueueAtRunStart(context, snapshot, {
      deadline: options.deadline ?? null,
      onOutput: options.onOutput,
      onProviderStart: options.onProviderStart,
      signal: options.signal,
      streamProviderOutput: options.streamProviderOutput,
    });
    const queueFile = startup.queueFile;
    const step = nextStep(queueFile);
    if (!step) return null;

    return planStep(context, step, snapshot, options);
  } finally {
    await releaseLock();
  }
}

export async function run(context: ProjectContext, options: RunOptions = {}): Promise<number> {
  const { maxHours, maxSteps = 1, streamProviderOutput = false } = options;
  const releaseLock = await acquireProjectLock(context);
  const controlState: RunControlState = { activeAbortController: null, current: null, stopRequested: false };
  options.onControl?.(createRunControl(controlState, (event) => emitRunEvent(options, event)));

  try {
    emitRunEvent(options, { type: "validate" });
    const snapshot = await readRunSnapshot(context, { operatorDirective: options.operatorDirective });
    const deadline = maxHours === undefined ? null : Date.now() + maxHours * 60 * 60 * 1000;
    let completed = 0;
    let completedResult: number | undefined;
    let queueFile: QueueFile | null = null;

    let primaryError: unknown;
    let cleanupError: unknown;
    try {
      if (deadline !== null && Date.now() >= deadline) {
        completedResult = 0;
      } else {
        await cleanupProcesses(context, { force: true });
        emitRunEvent(options, { type: "startup-refresh" });
        await ensureProviderAvailable(context);
        if (options.initialQueueFile) {
          queueFile = options.initialQueueFile;
        } else {
          const startup = await runAbortableOperation(controlState, (signal) =>
            refreshQueueAtRunStart(context, snapshot, {
              deadline,
              onOutput: () => emitRunActivity(options, { phase: "startup-refresh" }),
              onProviderStart: (event) => emitRunEvent(options, { ...event, type: "provider-start" }),
              signal,
              streamProviderOutput,
            }),
          );
          queueFile = startup.queueFile;
        }
        emitRunEvent(options, { queueFile, type: "queue-updated" });
      }

      while (completed < maxSteps && !controlState.stopRequested) {
        if (deadline !== null && Date.now() >= deadline) {
          completedResult = completed;
          break;
        }

        if (!queueFile) {
          completedResult = completed;
          break;
        }
        const step = nextStep(queueFile);
        if (!step) {
          completedResult = completed;
          break;
        }

        emitRunEvent(options, { step, type: "step" });
        let stepResult: Awaited<ReturnType<typeof runStepWithRestarts>>;
        try {
          stepResult = await runStepWithRestarts({
            context,
            controlState,
            deadline,
            emitActivity: (event) => emitRunActivity(options, event),
            emitEvent: (event) => emitRunEvent(options, event),
            queueFile,
            snapshot,
            step,
            streamProviderOutput,
          });
        } catch (error) {
          if (isRunStopRequested(error) || controlState.stopRequested) {
            completedResult = completed;
            break;
          }
          throw error;
        }
        completed += 1;
        queueFile = stepResult.queueFile;
        if (controlState.stopRequested) break;
        if (deadline !== null && Date.now() >= deadline) {
          completedResult = completed;
          break;
        }
        emitRunEvent(options, { step: stepResult.step, type: "reconcile" });
        try {
          queueFile = await runAbortableOperation(controlState, (signal) =>
            reconcileQueue(context, queueFile!, stepResult.step, snapshot, stepResult.logDir, {
              deadline,
              onOutput: () => emitRunActivity(options, { phase: "reconcile", step: stepResult.step }),
              onProviderStart: (event) => emitRunEvent(options, { ...event, step: stepResult.step, type: "provider-start" }),
              signal,
              streamProviderOutput,
            }),
          );
          emitRunEvent(options, { queueFile, type: "queue-updated" });
        } catch (error) {
          if (isRunStopRequested(error) || controlState.stopRequested) {
            completedResult = completed;
            break;
          }
          throw error;
        }
      }

      completedResult ??= completed;
    } catch (error) {
      if (isRunStopRequested(error) || controlState.stopRequested) {
        completedResult ??= completed;
      } else {
        primaryError = error;
        throw error;
      }
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

async function runAbortableOperation<T>(state: RunControlState, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const abortController = new AbortController();
  state.activeAbortController = abortController;
  if (state.stopRequested) abortController.abort();

  try {
    const result = await operation(abortController.signal);
    if (state.stopRequested) throw new RunStopRequested();
    return result;
  } finally {
    if (state.activeAbortController === abortController) state.activeAbortController = null;
  }
}

function emitRunActivity(options: RunOptions, event: RoadrunnerRunActivityEvent): void {
  if (options.onActivity) options.onActivity(event);
}

function emitRunEvent(options: RunOptions, event: RoadrunnerRunEvent): void {
  if (options.onEvent) options.onEvent(event);
}

export async function validateProvider(context: ProjectContext): Promise<string[]> {
  return validateConfiguredProvider(context);
}

async function ensureProviderAvailable(context: ProjectContext): Promise<void> {
  const errors = await validateProvider(context);
  if (errors.length > 0) throw new Error(errors.join("\n"));
}
