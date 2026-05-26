import { readFile } from "node:fs/promises";
import path from "node:path";

import { pathExists, type ProjectContext } from "../infrastructure/config.js";
import type { ProviderStartEvent } from "../infrastructure/providers/index.js";
import type { QueueFile } from "../domain/queue.js";
import { queueFileFromRoadmap } from "../domain/roadmap.js";
import { trustedVerificationCommands, validateVerificationPolicy } from "../domain/verification-policy.js";
import type { RunSnapshot } from "./run-snapshot.js";
import { createLogDir, renderPrompt, writePrivateFile } from "../infrastructure/run-artifacts.js";
import { appendQueueProposalContract, queueProposalFromOutput } from "./queue-proposal.js";
import { runProviderRole } from "./provider-runner.js";
import { errorMessage, formatContextualError } from "./error-message.js";

export interface StartupRefreshOptions {
  deadline: number | null;
  onOutput?: () => void;
  onProviderStart?: (event: ProviderStartEvent) => void;
  signal?: AbortSignal;
  streamProviderOutput?: boolean;
}

export interface StartupRefreshResult {
  logDir: string;
  queueFile: QueueFile;
}

export async function seedQueueAtRunStart(context: ProjectContext): Promise<QueueFile> {
  return seedQueueFromRoadmap(context, await readRoadmapMarkdown(context)).queueFile;
}

export async function refreshQueueAtRunStart(context: ProjectContext, snapshot: RunSnapshot, options: StartupRefreshOptions): Promise<StartupRefreshResult> {
  const roadmapMarkdown = await readRoadmapMarkdown(context);
  const seed = seedQueueFromRoadmap(context, roadmapMarkdown);

  const logDir = await createLogDir(context, "startup-refresh");
  const prompt = appendQueueProposalContract(await renderPrompt(context, "startup-refresh.md", {
    GOALS_MD: snapshot.goalsMarkdown,
    OPERATOR_DIRECTIVE_MD: snapshot.operatorDirectiveMarkdown,
    QUEUE_JSON: JSON.stringify(seed.queueFile, null, 2),
    ROADMAP_MD: roadmapMarkdown,
    ROADMAP_PARSE_STATUS: seed.parseStatus,
  }));
  await writePrivateFile(path.join(logDir, "startup-refresh.prompt.md"), prompt);
  const providerLogPath = path.join(logDir, "startup-refresh.opencode.log");

  const result = await runProviderRole(context, {
    agent: "plan",
    deadline: options.deadline,
    logPath: providerLogPath,
    onOutput: options.onOutput,
    onProviderStart: options.onProviderStart,
    prompt,
    role: "startup-refresh",
    signal: options.signal,
    streamProviderOutput: options.streamProviderOutput,
    workspaceAccess: "read-only",
  });
  await writePrivateFile(path.join(logDir, "startup-refresh.md"), result.output);

  if (result.code !== 0) throw new Error(formatContextualError("Startup refresh provider failed.", [`Exit code: ${String(result.code)}.`], providerLogPath));

  let queueFile: QueueFile;
  try {
    queueFile = queueProposalFromOutput(result.output, context);
  } catch (error) {
    throw new Error(formatContextualError("Startup refresh returned an invalid queue proposal.", [errorMessage(error)], providerLogPath));
  }
  const validationErrors = [
    ...validateStartupQueueScope(queueFile),
    ...validateVerificationPolicy({
      allowedCommands: context.config.allowedVerificationCommands,
      proposed: queueFile,
      trustedCommands: trustedVerificationCommands(seed.queueFile),
    }),
  ];
  if (validationErrors.length > 0) throw new Error(formatContextualError("Startup refresh returned an invalid queue proposal.", validationErrors, providerLogPath));

  return { logDir, queueFile };
}

function validateStartupQueueScope(queueFile: QueueFile): string[] {
  return queueFile.history.length > 0 ? ["Startup refresh must not mark work as history; keep uncertain work queued or remove obsolete work from the open queue."] : [];
}

async function readRoadmapMarkdown(context: ProjectContext): Promise<string> {
  if (!(await pathExists(context.paths.roadmap))) return "";
  return readFile(context.paths.roadmap, "utf8");
}

function seedQueueFromRoadmap(context: ProjectContext, roadmapMarkdown: string): { parseStatus: string; queueFile: QueueFile } {
  if (roadmapMarkdown.trim().length === 0) return { parseStatus: `No roadmap file was found at ${context.paths.roadmap}.`, queueFile: emptyQueue(context) };

  try {
    return { parseStatus: "Roadmap parsed into an initial operational queue before AI audit.", queueFile: queueFileFromRoadmap(roadmapMarkdown, context.config) };
  } catch (error) {
    return { parseStatus: `Roadmap is strategic or not in operational queue format: ${(error as Error).message}`, queueFile: emptyQueue(context) };
  }
}

function emptyQueue(context: ProjectContext): QueueFile {
  return {
    version: 2,
    model: context.config.model,
    variant: context.config.variant,
    queue: [],
    history: [],
    blocked: [],
  };
}
