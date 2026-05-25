import path from "node:path";

import type { ProjectContext } from "./config.js";
import { projectMutationFingerprint } from "./mutation-fingerprint.js";
import type { QueueFile, QueueStep } from "./queue.js";
import { readValidatedQueue } from "./queue-service.js";
import { providerFor, type ProviderStartEvent } from "./providers/index.js";
import type { RunSnapshot } from "./run-snapshot.js";
import { renderPrompt, writePrivateFile } from "./run-artifacts.js";
import { providerEnvForDeadline } from "./timeouts.js";

interface ReconcileOptions {
  deadline: number | null;
  onOutput?: () => void;
  onProviderStart?: (event: ProviderStartEvent) => void;
  signal?: AbortSignal;
}

export async function reconcileQueue(context: ProjectContext, step: QueueStep, snapshot: RunSnapshot, logDir: string, options: ReconcileOptions): Promise<QueueFile> {
  const queueBeforeReconcile = await readValidatedQueue(context);
  const queueText = `${JSON.stringify(queueBeforeReconcile, null, 2)}\n`;
  const beforeMutationFingerprint = await projectMutationFingerprint(context, { ignoredPaths: [context.paths.queue] });

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
    onOutput: options.onOutput,
    onStart: options.onProviderStart,
    prompt,
    role: "reconcile",
    signal: options.signal,
    skipPermissions: context.config.dangerouslySkipPermissions,
  });
  await writePrivateFile(path.join(logDir, "reconcile.md"), result.output);

  const afterMutationFingerprint = await projectMutationFingerprint(context, { ignoredPaths: [context.paths.queue] });
  if (beforeMutationFingerprint !== null && afterMutationFingerprint !== null && beforeMutationFingerprint !== afterMutationFingerprint) {
    throw new Error("Reconciliation may only update the Roadrunner queue file.");
  }

  if (result.code !== 0) throw new Error(`Reconciliation failed for ${step.id}.`);

  const normalizedQueueFile = await readValidatedQueue(context);
  const preserveErrors = validateReconcileQueueScope(queueBeforeReconcile, normalizedQueueFile, step.id);
  if (preserveErrors.length > 0) throw new Error(preserveErrors.join("\n"));

  return normalizedQueueFile;
}

function validateReconcileQueueScope(before: QueueFile, after: QueueFile, currentStepId: string): string[] {
  const errors: string[] = [];
  if (JSON.stringify(after.history) !== JSON.stringify(before.history)) errors.push("Reconciliation must preserve history records.");
  if (JSON.stringify(after.blocked) !== JSON.stringify(before.blocked)) errors.push("Reconciliation must preserve blocked records.");
  if (JSON.stringify(after.queue[0] ?? null) !== JSON.stringify(before.queue[0] ?? null)) errors.push(`Reconciliation must preserve queue[0] for ${currentStepId}.`);
  return errors;
}
