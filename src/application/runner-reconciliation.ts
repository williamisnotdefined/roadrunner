import path from "node:path";

import type { ProjectContext } from "../infrastructure/config.js";
import { projectMutationFingerprint } from "../infrastructure/mutation-fingerprint.js";
import { type QueueFile, type QueueStep, writeQueue } from "../domain/queue.js";
import { readValidatedQueue } from "./queue-service.js";
import { providerFor, type ProviderStartEvent } from "../infrastructure/providers/index.js";
import type { RunSnapshot } from "./run-snapshot.js";
import { renderPrompt, writePrivateFile } from "../infrastructure/run-artifacts.js";
import { providerEnvForDeadline } from "../domain/timeouts.js";

interface ReconcileOptions {
  deadline: number | null;
  onOutput?: () => void;
  onProviderStart?: (event: ProviderStartEvent) => void;
  signal?: AbortSignal;
  streamProviderOutput?: boolean;
}

export async function reconcileQueue(context: ProjectContext, step: QueueStep, snapshot: RunSnapshot, logDir: string, options: ReconcileOptions): Promise<QueueFile> {
  const queueBeforeReconcile = await readValidatedQueue(context);
  const queueText = `${JSON.stringify(queueBeforeReconcile, null, 2)}\n`;
  const beforeMutationFingerprint = await projectMutationFingerprint(context, { ignoredPaths: [context.paths.queue], includeIgnoredFiles: true });

  const prompt = await renderPrompt(context, "reconcile-roadmap.md", {
    GOALS_MD: snapshot.goalsMarkdown,
    QUEUE_JSON: queueText,
    STEP_JSON: JSON.stringify(step, null, 2),
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
    streamOutput: options.streamProviderOutput,
  });
  await writePrivateFile(path.join(logDir, "reconcile.md"), result.output);

  const afterMutationFingerprint = await projectMutationFingerprint(context, { ignoredPaths: [context.paths.queue], includeIgnoredFiles: true });
  if (beforeMutationFingerprint !== null && afterMutationFingerprint !== null && beforeMutationFingerprint !== afterMutationFingerprint) {
    await writeQueue(queueBeforeReconcile, context);
    throw new Error("Reconciliation may only update the Roadrunner queue file.");
  }

  if (result.code !== 0) {
    await writeQueue(queueBeforeReconcile, context);
    throw new Error(`Reconciliation failed for ${step.id}.`);
  }

  let normalizedQueueFile: QueueFile;
  try {
    normalizedQueueFile = await readValidatedQueue(context);
  } catch (error) {
    await writeQueue(queueBeforeReconcile, context);
    throw error;
  }

  const preserveErrors = validateReconcileQueueScope(queueBeforeReconcile, normalizedQueueFile);
  if (preserveErrors.length > 0) {
    await writeQueue(queueBeforeReconcile, context);
    throw new Error(preserveErrors.join("\n"));
  }

  return normalizedQueueFile;
}

function validateReconcileQueueScope(before: QueueFile, after: QueueFile): string[] {
  const errors: string[] = [];
  if (JSON.stringify(after.history) !== JSON.stringify(before.history)) errors.push("Reconciliation must preserve history records.");
  if (JSON.stringify(after.blocked) !== JSON.stringify(before.blocked)) errors.push("Reconciliation must preserve blocked records.");
  return errors;
}
