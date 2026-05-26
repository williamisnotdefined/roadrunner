import path from "node:path";

import type { ProjectContext } from "../infrastructure/config.js";
import { normalizeQueueFile, validateQueueFile, type QueueFile, type QueueStep } from "../domain/queue.js";
import type { ProviderStartEvent } from "../infrastructure/providers/index.js";
import type { RunSnapshot } from "./run-snapshot.js";
import { renderPrompt, writePrivateFile } from "../infrastructure/run-artifacts.js";
import { appendQueueProposalContract, queueProposalFromOutput } from "./queue-proposal.js";
import { runProviderRole } from "./provider-runner.js";

interface ReconcileOptions {
  deadline: number | null;
  onOutput?: () => void;
  onProviderStart?: (event: ProviderStartEvent) => void;
  signal?: AbortSignal;
  streamProviderOutput?: boolean;
}

export async function reconcileQueue(context: ProjectContext, queueBeforeReconcile: QueueFile, step: QueueStep, snapshot: RunSnapshot, logDir: string, options: ReconcileOptions): Promise<QueueFile> {
  const queueText = `${JSON.stringify(queueBeforeReconcile, null, 2)}\n`;

  const prompt = appendQueueProposalContract(await renderPrompt(context, "reconcile-roadmap.md", {
    GOALS_MD: snapshot.goalsMarkdown,
    QUEUE_JSON: queueText,
    STEP_JSON: JSON.stringify(step, null, 2),
  }));
  await writePrivateFile(path.join(logDir, "reconcile.prompt.md"), prompt);

  const result = await runProviderRole(context, {
    agent: "plan",
    deadline: options.deadline,
    logPath: path.join(logDir, "reconcile.opencode.log"),
    onOutput: options.onOutput,
    onProviderStart: options.onProviderStart,
    prompt,
    role: "reconcile",
    signal: options.signal,
    streamProviderOutput: options.streamProviderOutput,
    workspaceAccess: "read-only",
  });
  await writePrivateFile(path.join(logDir, "reconcile.md"), result.output);

  if (result.code !== 0) throw new Error(`Reconciliation failed for ${step.id}.`);

  const proposedQueueFile = queueProposalFromOutput(result.output, context);
  const normalizedQueueFile = preserveClosedRecords(queueBeforeReconcile, proposedQueueFile);
  const errors = [
    ...validateReconcileQueueScope(queueBeforeReconcile, normalizedQueueFile),
    ...validateQueueFile(normalizedQueueFile, { model: context.config.model, variant: context.config.variant }),
  ];
  if (errors.length > 0) throw new Error(errors.join("\n"));

  return normalizedQueueFile;
}

function preserveClosedRecords(before: QueueFile, proposed: QueueFile): QueueFile {
  return normalizeQueueFile({ ...proposed, history: before.history, blocked: before.blocked });
}

function validateReconcileQueueScope(before: QueueFile, after: QueueFile): string[] {
  const errors: string[] = [];
  if (after.version !== before.version) errors.push("Reconciliation must preserve queue version.");
  if (after.model !== before.model) errors.push("Reconciliation must preserve queue model.");
  if (after.variant !== before.variant) errors.push("Reconciliation must preserve queue variant.");
  if (JSON.stringify(after.history) !== JSON.stringify(before.history)) errors.push("Reconciliation must preserve history records.");
  if (JSON.stringify(after.blocked) !== JSON.stringify(before.blocked)) errors.push("Reconciliation must preserve blocked records.");
  return errors;
}
