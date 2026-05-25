import path from "node:path";

import type { ProjectContext } from "./config.js";
import { acquireProjectLock } from "./lock.js";
import { formatStep, markDone, nextStep, writeQueue, type QueueStep } from "./queue.js";
import { blockStep, readValidatedQueue } from "./queue-service.js";
import { cleanupProcesses } from "./process-registry.js";
import { providerFor, validateConfiguredProvider, type ProviderStartEvent } from "./providers/index.js";
import { readRunSnapshot } from "./run-snapshot.js";
import { createLogDir, renderPrompt, writePrivateFile } from "./run-artifacts.js";
import { planStep, type PlanOptions } from "./runner-planning.js";
import { reconcileQueue } from "./runner-reconciliation.js";
import { fixFailure, verify as verifyStep } from "./runner-verification.js";
import { providerEnvForDeadline } from "./timeouts.js";

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
  onEvent?: (event: RoadrunnerRunEvent) => void;
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
        let verification = await verifyStep(context, step, logDir, { deadline });
        if (!verification.ok) {
          emitRunEvent(options, { step, type: "fix" });
          const fix = await fixFailure(context, step, snapshot, planResult.result.output, verification.output, logDir, {
            deadline,
            onProviderStart: (event) => emitRunEvent(options, { ...event, step, type: "provider-start" }),
          });
          if (fix.code === 0) {
            emitRunEvent(options, { attempt: "fixed", step, type: "verify" });
            verification = await verifyStep(context, step, logDir, { deadline, prefix: "verify-fixed" });
          }
        }

        if (!verification.ok) {
          await blockStep(context, queueFile, step, "Verification failed after fix attempt.");
          throw new Error(`Verification failed for ${step.id}.`);
        }

        emitRunEvent(options, { step, type: "reconcile" });
        try {
          const reconciledQueue = await reconcileQueue(context, step, snapshot, logDir, {
            deadline,
            onProviderStart: (event) => emitRunEvent(options, { ...event, step, type: "provider-start" }),
          });
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
