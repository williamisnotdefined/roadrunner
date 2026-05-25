import path from "node:path";

import type { ProjectContext } from "./config.js";
import { cleanupProcesses } from "./process-registry.js";
import { formatStep, markDone, type QueueFile, type QueueStep, writeQueue } from "./queue.js";
import { blockStep } from "./queue-service.js";
import { providerFor } from "./providers/index.js";
import type { RunSnapshot } from "./run-snapshot.js";
import { createLogDir, renderPrompt, writePrivateFile } from "./run-artifacts.js";
import { planStep } from "./runner-planning.js";
import { reconcileQueue } from "./runner-reconciliation.js";
import { fixFailure, verify as verifyStep } from "./runner-verification.js";
import { providerEnvForDeadline } from "./timeouts.js";
import type { RoadrunnerRunActivityEvent, RoadrunnerRunControl, RoadrunnerRunEvent, RoadrunnerRunPhase } from "./runner.js";

export interface CurrentAttemptState {
  abortController: AbortController;
  phase: RoadrunnerRunPhase | null;
  restartRequested: boolean;
  startedAt: number;
  step: QueueStep;
}

export interface RunControlState {
  current: CurrentAttemptState | null;
}

interface RunStepInput {
  context: ProjectContext;
  controlState: RunControlState;
  deadline: number | null;
  emitActivity: (event: RoadrunnerRunActivityEvent) => void;
  emitEvent: (event: RoadrunnerRunEvent) => void;
  queueFile: QueueFile;
  snapshot: RunSnapshot;
  step: QueueStep;
}

export function createRunControl(state: RunControlState, emitEvent: (event: RoadrunnerRunEvent) => void): RoadrunnerRunControl {
  return {
    restartCurrentTask() {
      const current = state.current;
      if (!current) return false;
      if (current.restartRequested) return true;

      current.restartRequested = true;
      emitEvent({ elapsedMs: Date.now() - current.startedAt, phase: current.phase, step: current.step, type: "task-restart-requested" });
      current.abortController.abort();
      return true;
    },
  };
}

export async function runStepWithRestarts({ context, controlState, deadline, emitActivity, emitEvent, queueFile, snapshot, step }: RunStepInput): Promise<void> {
  let attempt = 1;

  while (true) {
    const attemptState = startAttempt(controlState, step);

    try {
      setAttemptPhase(attemptState, "plan");
      emitEvent({ step, type: "plan" });
      const planResult = await withRestartCheck(
        () =>
          planStep(context, step, snapshot, {
            deadline,
            onOutput: activityEmitter(emitActivity, step, "plan"),
            onProviderStart: (event) => emitEvent({ ...event, step, type: "provider-start" }),
            signal: attemptState.abortController.signal,
          }),
        attemptState,
      );
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

      setAttemptPhase(attemptState, "implement");
      emitEvent({ step, type: "implement" });
      const result = await withRestartCheck(
        () =>
          providerFor(context).run({
            agent: "build",
            context,
            env: providerEnvForDeadline(deadline),
            logPath: path.join(logDir, "implement.opencode.log"),
            onOutput: activityEmitter(emitActivity, step, "implement"),
            onStart: (event) => emitEvent({ ...event, step, type: "provider-start" }),
            prompt,
            role: "implement",
            signal: attemptState.abortController.signal,
            skipPermissions: context.config.dangerouslySkipPermissions,
          }),
        attemptState,
      );
      if (result.code !== 0) {
        await blockStep(context, queueFile, step, `Provider exited ${String(result.code)}`);
        throw new Error(`Implementation failed for ${step.id}.`);
      }

      setAttemptPhase(attemptState, "verify");
      emitEvent({ attempt: "initial", step, type: "verify" });
      let verification = await withRestartCheck(
        () => verifyStep(context, step, logDir, { deadline, onOutput: activityEmitter(emitActivity, step, "verify"), signal: attemptState.abortController.signal }),
        attemptState,
      );
      if (!verification.ok) {
        setAttemptPhase(attemptState, "fix");
        emitEvent({ step, type: "fix" });
        const fix = await withRestartCheck(
          () =>
            fixFailure(context, step, snapshot, planResult.result.output, verification.output, logDir, {
              deadline,
              onOutput: activityEmitter(emitActivity, step, "fix"),
              onProviderStart: (event) => emitEvent({ ...event, step, type: "provider-start" }),
              signal: attemptState.abortController.signal,
            }),
          attemptState,
        );
        if (fix.code === 0) {
          setAttemptPhase(attemptState, "verify-fixed");
          emitEvent({ attempt: "fixed", step, type: "verify" });
          verification = await withRestartCheck(
            () =>
              verifyStep(context, step, logDir, {
                deadline,
                onOutput: activityEmitter(emitActivity, step, "verify-fixed"),
                prefix: "verify-fixed",
                signal: attemptState.abortController.signal,
              }),
            attemptState,
          );
        }
      }

      if (!verification.ok) {
        await blockStep(context, queueFile, step, "Verification failed after fix attempt.");
        throw new Error(`Verification failed for ${step.id}.`);
      }

      setAttemptPhase(attemptState, "reconcile");
      emitEvent({ step, type: "reconcile" });
      try {
        const reconciledQueue = await withRestartCheck(
          () =>
            reconcileQueue(context, step, snapshot, logDir, {
              deadline,
              onOutput: activityEmitter(emitActivity, step, "reconcile"),
              onProviderStart: (event) => emitEvent({ ...event, step, type: "provider-start" }),
              signal: attemptState.abortController.signal,
            }),
          attemptState,
        );
        controlState.current = null;
        markDone(reconciledQueue, step.id);
        await writeQueue(reconciledQueue, context);
      } catch (error) {
        if (isTaskRestartRequest(error) || attemptState.restartRequested) throw error;
        await blockStep(context, queueFile, step, `Reconciliation failed: ${(error as Error).message}`, { useLatest: false });
        throw error;
      }

      emitEvent({ step, type: "step-complete" });
      return;
    } catch (error) {
      if (isTaskRestartRequest(error) || attemptState.restartRequested) {
        await restartAttempt(context, controlState, attemptState, attempt + 1, emitEvent);
        attempt += 1;
        continue;
      }
      controlState.current = null;
      throw error;
    }
  }
}

function startAttempt(state: RunControlState, step: QueueStep): CurrentAttemptState {
  const current: CurrentAttemptState = {
    abortController: new AbortController(),
    phase: null,
    restartRequested: false,
    startedAt: Date.now(),
    step,
  };
  state.current = current;
  return current;
}

function setAttemptPhase(current: CurrentAttemptState, phase: RoadrunnerRunPhase): void {
  current.phase = phase;
}

class TaskRestartRequest extends Error {}

async function withRestartCheck<T>(operation: () => Promise<T>, current: CurrentAttemptState): Promise<T> {
  const result = await operation();
  if (current.restartRequested) throw new TaskRestartRequest();
  return result;
}

function isTaskRestartRequest(error: unknown): boolean {
  return error instanceof TaskRestartRequest;
}

async function restartAttempt(context: ProjectContext, state: RunControlState, current: CurrentAttemptState, nextAttempt: number, emitEvent: (event: RoadrunnerRunEvent) => void): Promise<void> {
  state.current = null;
  await cleanupProcesses(context, { force: true });
  emitEvent({ attempt: nextAttempt, step: current.step, type: "task-restart" });
}

function activityEmitter(emitActivity: (event: RoadrunnerRunActivityEvent) => void, step: QueueStep, phase: RoadrunnerRunPhase): () => void {
  return () => emitActivity({ phase, step });
}
