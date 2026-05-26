import { readFile } from "node:fs/promises";
import path from "node:path";

import { normalizeQueueFile, validateQueueFile, type QueueFile } from "../domain/queue.js";
import type { ProjectContext } from "../infrastructure/config.js";
import { pathExists } from "../infrastructure/config.js";
import type { ProviderStartEvent } from "../infrastructure/providers/index.js";
import { createLogDir, renderPrompt, writePrivateFile } from "../infrastructure/run-artifacts.js";
import { appendQueueProposalContract, queueProposalFromOutput } from "./queue-proposal.js";
import type { RunSnapshot } from "./run-snapshot.js";
import { runProviderRole } from "./provider-runner.js";

export interface GlobalReconcileOptions {
  deadline: number | null;
  onOutput?: () => void;
  onProviderStart?: (event: ProviderStartEvent) => void;
  signal?: AbortSignal;
  streamProviderOutput?: boolean;
}

export interface GlobalReconcileResult {
  logDir: string;
  queueFile: QueueFile;
}

export async function reconcileProjectQueue(context: ProjectContext, queueFile: QueueFile, snapshot: RunSnapshot, options: GlobalReconcileOptions): Promise<GlobalReconcileResult> {
  const logDir = await createLogDir(context, "global-reconcile");
  const prompt = appendQueueProposalContract(await renderPrompt(context, "global-reconcile.md", {
    GOALS_MD: snapshot.goalsMarkdown,
    OPERATOR_DIRECTIVE_MD: snapshot.operatorDirectiveMarkdown,
    QUEUE_JSON: `${JSON.stringify(queueFile, null, 2)}\n`,
    ROADMAP_MD: await readRoadmapMarkdown(context),
  }));
  await writePrivateFile(path.join(logDir, "global-reconcile.prompt.md"), prompt);

  const result = await runProviderRole(context, {
    agent: "plan",
    deadline: options.deadline,
    logPath: path.join(logDir, "global-reconcile.opencode.log"),
    onOutput: options.onOutput,
    onProviderStart: options.onProviderStart,
    prompt,
    role: "global-reconcile",
    signal: options.signal,
    streamProviderOutput: options.streamProviderOutput,
    workspaceAccess: "read-only",
  });
  await writePrivateFile(path.join(logDir, "global-reconcile.md"), result.output);
  if (result.code !== 0) throw new Error("Global reconciliation failed.");

  const proposedQueueFile = queueProposalFromOutput(result.output, context);
  const normalizedQueueFile = preserveClosedRecords(queueFile, proposedQueueFile);
  const errors = validateQueueFile(normalizedQueueFile, { model: context.config.model, variant: context.config.variant });
  if (errors.length > 0) throw new Error(errors.join("\n"));
  return { logDir, queueFile: normalizedQueueFile };
}

async function readRoadmapMarkdown(context: ProjectContext): Promise<string> {
  return (await pathExists(context.paths.roadmap)) ? readFile(context.paths.roadmap, "utf8") : "";
}

function preserveClosedRecords(before: QueueFile, proposed: QueueFile): QueueFile {
  return normalizeQueueFile({ ...proposed, history: before.history, blocked: before.blocked });
}
