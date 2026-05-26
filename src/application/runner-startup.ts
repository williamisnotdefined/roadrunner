import { readFile } from "node:fs/promises";
import path from "node:path";

import { pathExists, type ProjectContext } from "../infrastructure/config.js";
import { providerFor, type ProviderStartEvent } from "../infrastructure/providers/index.js";
import type { QueueFile } from "../domain/queue.js";
import { queueFileFromRoadmap } from "../domain/roadmap.js";
import type { RunSnapshot } from "./run-snapshot.js";
import { createLogDir, renderPrompt, writePrivateFile } from "../infrastructure/run-artifacts.js";
import { providerEnvForDeadline } from "../domain/timeouts.js";
import { queueProposalFromOutput } from "./queue-proposal.js";

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
  const prompt = await renderPrompt(context, "startup-refresh.md", {
    GOALS_MD: snapshot.goalsMarkdown,
    QUEUE_JSON: JSON.stringify(seed.queueFile, null, 2),
    QUEUE_PATH: path.relative(context.root, context.paths.queue).split(path.sep).join(path.posix.sep),
    ROADMAP_MD: roadmapMarkdown,
    ROADMAP_PARSE_STATUS: seed.parseStatus,
  });
  await writePrivateFile(path.join(logDir, "startup-refresh.prompt.md"), prompt);

  const result = await providerFor(context).run({
    agent: "plan",
    context,
    env: providerEnvForDeadline(options.deadline),
    logPath: path.join(logDir, "startup-refresh.opencode.log"),
    onOutput: options.onOutput,
    onStart: options.onProviderStart,
    prompt,
    role: "startup-refresh",
    signal: options.signal,
    skipPermissions: false,
    streamOutput: options.streamProviderOutput,
  });
  await writePrivateFile(path.join(logDir, "startup-refresh.md"), result.output);

  if (result.code !== 0) throw new Error(`Startup refresh failed (exit ${String(result.code)}).`);

  return { logDir, queueFile: queueProposalFromOutput(result.output, context) };
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
