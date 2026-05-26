import path from "node:path";

import { recordAttemptActivity, startAutoRestartWatchdog } from "./auto-restart-watchdog.js";
import type { ProjectContext } from "../infrastructure/config.js";
import { cleanupProcesses } from "../infrastructure/process-registry.js";
import { formatStep, markBlocked, markDone, normalizeQueueFile, type QueueFile, type QueueStep } from "../domain/queue.js";
import { automaticRestartBlockedReason, resolveAutoRestartPolicy } from "../domain/restart-policy.js";
import type { RunSnapshot } from "./run-snapshot.js";
import { createLogDir, renderPrompt, writePrivateFile } from "../infrastructure/run-artifacts.js";
import type { CurrentAttemptState, RunControlState } from "./runner-control.js";
import { planStep } from "./runner-planning.js";
import { fixFailure, verify as verifyStep, type VerificationFailure } from "./runner-verification.js";
import type { RoadrunnerRunActivityEvent, RoadrunnerRunEvent, RoadrunnerRunPhase } from "./runner.js";
import { runProviderRole } from "./provider-runner.js";
import { PlanOutputError } from "./plan-output.js";
import { AutomaticRestartLimitExceededError } from "./run-errors.js";
import { formatContextualError } from "./error-message.js";

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
  queueFile: QueueFile;
  step: QueueStep;
}

export async function runStepWithRestarts({ context, controlState, deadline, emitActivity, emitEvent, queueFile, snapshot, step, streamProviderOutput }: RunStepInput): Promise<RunStepResult> {
  let attempt = 1;
  let autoRestartCount = 0;
  const autoRestartPolicy = resolveAutoRestartPolicy(context.config);
  const originalQueueFile = normalizeQueueFile(queueFile);

  while (true) {
    const attemptQueueFile = normalizeQueueFile(originalQueueFile);
    const attemptStep = attemptQueueFile.queue[0];
    if (!attemptStep || attemptStep.id !== step.id) throw new Error(`Roadrunner queue changed before retrying ${step.id}.`);

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
      let planResult: Awaited<ReturnType<typeof planStep>>;
      try {
        planResult = await withControlCheck(
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
      } catch (error) {
        if (error instanceof PlanOutputError) emitEvent({ queueFile: blockedQueue(originalQueueFile, step, `Planning output invalid: ${error.message}`), type: "queue-updated" });
        throw error;
      }
      if (planResult.result.code !== 0) {
        emitEvent({ queueFile: blockedQueue(originalQueueFile, step, `Planning exited ${String(planResult.result.code)}`), type: "queue-updated" });
        throw new Error(formatContextualError(`Planning provider failed for ${attemptStep.id}.`, [`Exit code: ${String(planResult.result.code)}.`], path.join(planResult.logDir, "plan.opencode.log")));
      }

      const logDir = await createLogDir(context, attemptStep.id);
      const prompt = await renderPrompt(context, "implement-step.md", {
        GOALS_MD: snapshot.goalsMarkdown,
        OPERATOR_DIRECTIVE_MD: snapshot.operatorDirectiveMarkdown,
        PLAN_MD: planResult.planMarkdown!,
        ROADMAP_STATUS: formatStep(attemptStep),
        STEP_JSON: JSON.stringify(attemptStep, null, 2),
      });
      await writePrivateFile(path.join(logDir, "implement.prompt.md"), prompt);

      setAttemptPhase(attemptState, "implement");
      emitEvent({ step: attemptStep, type: "implement" });
      const result = await withControlCheck(
        () =>
          runProviderRole(context, {
            agent: "build",
            deadline,
            logPath: path.join(logDir, "implement.opencode.log"),
            onOutput: activityEmitter(attemptState, emitActivity, attemptStep, "implement"),
            onProviderStart: (event) => {
              recordAttemptActivity(attemptState);
              emitEvent({ ...event, step: attemptStep, type: "provider-start" });
            },
            prompt,
            role: "implement",
            signal: attemptState.abortController.signal,
            streamProviderOutput,
            workspaceAccess: "write",
            bypassProviderPermissions: context.config.dangerouslySkipPermissions,
          }),
        controlState,
        attemptState,
      );
      if (result.code !== 0) {
        emitEvent({ queueFile: blockedQueue(originalQueueFile, step, `Provider exited ${String(result.code)}`), type: "queue-updated" });
        throw new Error(formatContextualError(`Implementation provider failed for ${attemptStep.id}.`, [`Exit code: ${String(result.code)}.`], path.join(logDir, "implement.opencode.log")));
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
      let fixExitCode: number | null | undefined;
      if (!verification.ok) {
        setAttemptPhase(attemptState, "fix");
        emitEvent({ step: attemptStep, type: "fix" });
        const fix = await withControlCheck(
          () =>
            fixFailure(context, attemptStep, snapshot, planResult.planMarkdown!, verification.output, logDir, {
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
        } else {
          fixExitCode = fix.code;
        }
      }

      if (!verification.ok) {
        emitEvent({ queueFile: blockedQueue(originalQueueFile, step, "Verification failed after fix attempt."), type: "queue-updated" });
        throw new Error(formatVerificationFailure(attemptStep, verification.failedCommand, fixExitCode, path.join(logDir, "fix-failure.opencode.log")));
      }

      const completionQueue = normalizeQueueFile(originalQueueFile);
      markDone(completionQueue, attemptStep.id);

      controlState.current = null;
      emitEvent({ queueFile: completionQueue, type: "queue-updated" });
      emitEvent({ step: attemptStep, type: "step-complete" });
      return { logDir, queueFile: completionQueue, step: attemptStep };
    } catch (error) {
      if (isRunStopRequested(error) || controlState.stopRequested) {
        controlState.current = null;
        throw new RunStopRequested();
      }
      if (isTaskRestartRequest(error) || attemptState.restartRequested) {
        if (attemptState.restartReason?.type === "auto-limit") {
          emitEvent({ queueFile: blockedQueue(originalQueueFile, step, automaticRestartBlockedReason(autoRestartPolicy)), type: "queue-updated" });
          controlState.current = null;
          throw new AutomaticRestartLimitExceededError({
            idleMs: attemptState.restartReason.idleMs,
            maxRestarts: attemptState.restartReason.maxRestarts,
            phase: attemptState.phase,
            policy: autoRestartPolicy,
            step: attemptStep,
          });
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

function blockedQueue(queueFile: QueueFile, step: QueueStep, reason: string): QueueFile {
  const nextQueue = normalizeQueueFile(queueFile);
  markBlocked(nextQueue, step.id, reason);
  return nextQueue;
}

function formatVerificationFailure(step: QueueStep, failure: VerificationFailure, fixExitCode: number | null | undefined, fixLogPath: string): string {
  const details = [`Failed command: ${failure.command}`, `Command index: verification[${failure.index}].`, `Exit code: ${String(failure.code)}.`];
  if (fixExitCode !== undefined) details.push(`Fix attempt exit code: ${String(fixExitCode)}.`, `Fix attempt log: ${fixLogPath}`);
  else details.push(`Fix attempt log: ${fixLogPath}`);
  return formatContextualError(`Verification failed for ${step.id}.`, details, failure.logPath);
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
