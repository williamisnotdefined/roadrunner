import path from "node:path";

import { recordAttemptActivity, startAutoRestartWatchdog } from "./auto-restart-watchdog.js";
import type { ProjectContext } from "../infrastructure/config.js";
import { cleanupProcesses } from "../infrastructure/process-registry.js";
import { assertQueueUnchanged, readUnchangedCurrentQueue } from "./queue-guard.js";
import { formatStep, markDone, type QueueFile, type QueueStep, writeQueue } from "../domain/queue.js";
import { blockStep } from "./queue-service.js";
import { providerFor } from "../infrastructure/providers/index.js";
import { automaticRestartBlockedReason, resolveAutoRestartPolicy } from "../domain/restart-policy.js";
import type { RunSnapshot } from "./run-snapshot.js";
import { createLogDir, renderPrompt, writePrivateFile } from "../infrastructure/run-artifacts.js";
import type { CurrentAttemptState, RunControlState } from "./runner-control.js";
import { planStep } from "./runner-planning.js";
import { fixFailure, verify as verifyStep } from "./runner-verification.js";
import { providerEnvForDeadline } from "../domain/timeouts.js";
import type { RoadrunnerRunActivityEvent, RoadrunnerRunEvent, RoadrunnerRunPhase } from "./runner.js";

interface RunStepInput {
  context: ProjectContext;
  controlState: RunControlState;
  deadline: number | null;
  emitActivity: (event: RoadrunnerRunActivityEvent) => void;
  emitEvent: (event: RoadrunnerRunEvent) => void;
  queueFile: QueueFile;
  snapshot: RunSnapshot;
  step: QueueStep;
  streamProviderOutput: boolean;
}

export interface RunStepResult {
  logDir: string;
  step: QueueStep;
}

export async function runStepWithRestarts({ context, controlState, deadline, emitActivity, emitEvent, queueFile, snapshot, step, streamProviderOutput }: RunStepInput): Promise<RunStepResult> {
  let attempt = 1;
  let autoRestartCount = 0;
  const autoRestartPolicy = resolveAutoRestartPolicy(context.config);

  while (true) {
    let attemptQueueFile: QueueFile;
    let attemptStep: QueueStep;
    try {
      attemptQueueFile = await readUnchangedCurrentQueue(context, queueFile, step, `Roadrunner queue changed before retrying ${step.id}.`);
      attemptStep = attemptQueueFile.queue[0]!;
    } catch (error) {
      await blockStep(context, queueFile, step, (error as Error).message, { useLatest: false });
      throw error;
    }

    const attemptState = startAttempt(controlState, attemptStep);
    const stopAutoRestartWatchdog = startAutoRestartWatchdog({
      current: attemptState,
      emitEvent,
      incrementRestartCount: () => {
        autoRestartCount += 1;
        return autoRestartCount;
      },
      policy: autoRestartPolicy,
      restartCount: () => autoRestartCount,
    });

    try {
      setAttemptPhase(attemptState, "plan");
      emitEvent({ step: attemptStep, type: "plan" });
      const planResult = await withControlCheck(
        () =>
          planStep(context, attemptStep, snapshot, {
            deadline,
            onOutput: activityEmitter(attemptState, emitActivity, attemptStep, "plan"),
            onProviderStart: (event) => {
              recordAttemptActivity(attemptState);
              emitEvent({ ...event, step: attemptStep, type: "provider-start" });
            },
            signal: attemptState.abortController.signal,
            streamProviderOutput,
          }),
        controlState,
        attemptState,
      );
      if (planResult.result.code !== 0) {
        await blockStep(context, queueFile, step, `Planning exited ${String(planResult.result.code)}`, { useLatest: false });
        throw new Error(`Planning failed for ${attemptStep.id} (exit ${String(planResult.result.code)}). See ${path.join(planResult.logDir, "plan.opencode.log")}.`);
      }

      const logDir = await createLogDir(context, attemptStep.id);
      const prompt = await renderPrompt(context, "implement-step.md", {
        GOALS_MD: snapshot.goalsMarkdown,
        PLAN_MD: planResult.result.output,
        ROADMAP_STATUS: formatStep(attemptStep),
        STEP_JSON: JSON.stringify(attemptStep, null, 2),
      });
      await writePrivateFile(path.join(logDir, "implement.prompt.md"), prompt);

      setAttemptPhase(attemptState, "implement");
      emitEvent({ step: attemptStep, type: "implement" });
      const result = await withControlCheck(
        () =>
          providerFor(context).run({
            agent: "build",
            context,
            env: providerEnvForDeadline(deadline),
            logPath: path.join(logDir, "implement.opencode.log"),
            onOutput: activityEmitter(attemptState, emitActivity, attemptStep, "implement"),
            onStart: (event) => {
              recordAttemptActivity(attemptState);
              emitEvent({ ...event, step: attemptStep, type: "provider-start" });
            },
            prompt,
            role: "implement",
            signal: attemptState.abortController.signal,
            skipPermissions: context.config.dangerouslySkipPermissions,
            streamOutput: streamProviderOutput,
          }),
        controlState,
        attemptState,
      );
      await assertQueueUnchangedOrBlock(context, queueFile, step, "Implementation may not update the Roadrunner queue file.");
      if (result.code !== 0) {
        await blockStep(context, queueFile, step, `Provider exited ${String(result.code)}`, { useLatest: false });
        throw new Error(`Implementation failed for ${attemptStep.id}.`);
      }

      setAttemptPhase(attemptState, "verify");
      emitEvent({ attempt: "initial", step: attemptStep, type: "verify" });
      let verification = await withControlCheck(
        () =>
          verifyStep(context, attemptStep, logDir, {
            deadline,
            onOutput: activityEmitter(attemptState, emitActivity, attemptStep, "verify"),
            signal: attemptState.abortController.signal,
          }),
        controlState,
        attemptState,
      );
      await assertQueueUnchangedOrBlock(context, queueFile, step, "Verification may not update the Roadrunner queue file.");
      if (!verification.ok) {
        setAttemptPhase(attemptState, "fix");
        emitEvent({ step: attemptStep, type: "fix" });
        const fix = await withControlCheck(
          () =>
            fixFailure(context, attemptStep, snapshot, planResult.result.output, verification.output, logDir, {
              deadline,
              onOutput: activityEmitter(attemptState, emitActivity, attemptStep, "fix"),
              onProviderStart: (event) => {
                recordAttemptActivity(attemptState);
                emitEvent({ ...event, step: attemptStep, type: "provider-start" });
              },
              signal: attemptState.abortController.signal,
              streamProviderOutput,
            }),
          controlState,
          attemptState,
        );
        await assertQueueUnchangedOrBlock(context, queueFile, step, "Fix attempts may not update the Roadrunner queue file.");
        if (fix.code === 0) {
          setAttemptPhase(attemptState, "verify-fixed");
          emitEvent({ attempt: "fixed", step: attemptStep, type: "verify" });
          verification = await withControlCheck(
            () =>
              verifyStep(context, attemptStep, logDir, {
                deadline,
                onOutput: activityEmitter(attemptState, emitActivity, attemptStep, "verify-fixed"),
                prefix: "verify-fixed",
                signal: attemptState.abortController.signal,
              }),
            controlState,
            attemptState,
          );
          await assertQueueUnchangedOrBlock(context, queueFile, step, "Verification may not update the Roadrunner queue file.");
        }
      }

      if (!verification.ok) {
        await blockStep(context, queueFile, step, "Verification failed after fix attempt.", { useLatest: false });
        throw new Error(`Verification failed for ${attemptStep.id}.`);
      }

      try {
        const completionQueue = await readUnchangedCurrentQueue(context, queueFile, step, `Roadrunner queue changed before completing ${step.id}.`);
        markDone(completionQueue, attemptStep.id);
        await writeQueue(completionQueue, context);
      } catch (error) {
        if (isTaskRestartRequest(error) || attemptState.restartRequested) throw error;
        await blockStep(context, queueFile, step, (error as Error).message, { useLatest: false });
        throw error;
      }

      controlState.current = null;
      emitEvent({ step: attemptStep, type: "step-complete" });
      return { logDir, step: attemptStep };
    } catch (error) {
      if (isRunStopRequested(error) || controlState.stopRequested) {
        controlState.current = null;
        throw new RunStopRequested();
      }
      if (isTaskRestartRequest(error) || attemptState.restartRequested) {
        if (attemptState.restartReason?.type === "auto-limit") {
          await blockStep(context, queueFile, step, automaticRestartBlockedReason(autoRestartPolicy), { useLatest: false });
          controlState.current = null;
          throw new Error(`Automatic restart limit exceeded for ${attemptStep.id}.`);
        }
        await restartAttempt(context, controlState, attemptState, attempt + 1, emitEvent);
        attempt += 1;
        continue;
      }
      controlState.current = null;
      throw error;
    } finally {
      stopAutoRestartWatchdog();
    }
  }
}

async function assertQueueUnchangedOrBlock(context: ProjectContext, queueFile: QueueFile, step: QueueStep, message: string): Promise<void> {
  try {
    await assertQueueUnchanged(context, queueFile, message);
  } catch (error) {
    await blockStep(context, queueFile, step, (error as Error).message, { useLatest: false });
    throw error;
  }
}

function startAttempt(state: RunControlState, step: QueueStep): CurrentAttemptState {
  const now = Date.now();
  const current: CurrentAttemptState = {
    abortController: new AbortController(),
    lastActivityAt: now,
    phase: null,
    restartReason: null,
    restartRequested: false,
    startedAt: now,
    step,
  };
  state.current = current;
  return current;
}

function setAttemptPhase(current: CurrentAttemptState, phase: RoadrunnerRunPhase): void {
  current.phase = phase;
  recordAttemptActivity(current);
}

export class RunStopRequested extends Error {}

class TaskRestartRequest extends Error {}

async function withControlCheck<T>(operation: () => Promise<T>, state: RunControlState, current: CurrentAttemptState): Promise<T> {
  const result = await operation();
  if (state.stopRequested) throw new RunStopRequested();
  if (current.restartRequested) throw new TaskRestartRequest();
  return result;
}

export function isRunStopRequested(error: unknown): boolean {
  return error instanceof RunStopRequested;
}

function isTaskRestartRequest(error: unknown): boolean {
  return error instanceof TaskRestartRequest;
}

async function restartAttempt(
  context: ProjectContext,
  state: RunControlState,
  current: CurrentAttemptState,
  nextAttempt: number,
  emitEvent: (event: RoadrunnerRunEvent) => void,
): Promise<void> {
  state.current = null;
  await cleanupProcesses(context, { force: true });
  emitEvent({ attempt: nextAttempt, step: current.step, type: "task-restart" });
}

function activityEmitter(current: CurrentAttemptState, emitActivity: (event: RoadrunnerRunActivityEvent) => void, step: QueueStep, phase: RoadrunnerRunPhase): () => void {
  return () => {
    recordAttemptActivity(current);
    emitActivity({ phase, step });
  };
}
