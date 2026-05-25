import path from "node:path";

import type { ProjectContext } from "./config.js";
import type { QueueFile, QueueStep } from "./queue.js";
import { readValidatedQueue, validateQueueState } from "./queue-service.js";
import { providerFor, type ProviderStartEvent } from "./providers/index.js";
import type { RunSnapshot } from "./run-snapshot.js";
import { renderPrompt, writePrivateFile } from "./run-artifacts.js";
import { providerEnvForDeadline } from "./timeouts.js";

interface ReconcileOptions {
  deadline: number | null;
  onProviderStart?: (event: ProviderStartEvent) => void;
}

export async function reconcileQueue(context: ProjectContext, step: QueueStep, snapshot: RunSnapshot, logDir: string, options: ReconcileOptions): Promise<QueueFile> {
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
    env: providerEnvForDeadline(options.deadline),
    logPath: path.join(logDir, "reconcile.opencode.log"),
    onStart: options.onProviderStart,
    prompt,
    role: "reconcile",
    skipPermissions: context.config.dangerouslySkipPermissions,
  });
  await writePrivateFile(path.join(logDir, "reconcile.md"), result.output);

  if (result.code !== 0) throw new Error(`Reconciliation failed for ${step.id}.`);

  const normalizedQueueFile = await readValidatedQueue(context);
  const preserveErrors = validateClosedRecordsPreserved(queueBeforeReconcile, normalizedQueueFile, step.id);
  if (preserveErrors.length > 0) throw new Error(preserveErrors.join("\n"));

  const reconciledQueueFile = restoreVerifiedCurrentStep(queueBeforeReconcile, normalizedQueueFile, step.id);
  const reconciledErrors = validateQueueState(reconciledQueueFile, context);
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

function validateClosedRecordsPreserved(before: QueueFile, after: QueueFile, currentStepId: string): string[] {
  const errors: string[] = [];
  const afterHistory = after.history.filter((step) => step.id !== currentStepId);
  const afterBlocked = after.blocked.filter((step) => step.id !== currentStepId);
  if (JSON.stringify(afterHistory) !== JSON.stringify(before.history)) errors.push("Reconciliation must preserve history records.");
  if (JSON.stringify(afterBlocked) !== JSON.stringify(before.blocked)) errors.push("Reconciliation must preserve blocked records.");
  return errors;
}
