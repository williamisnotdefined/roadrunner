import { readFile } from "node:fs/promises";
import path from "node:path";

import { pathExists, type ProjectContext } from "./config.js";
import { projectMutationFingerprint } from "./mutation-fingerprint.js";
import { providerFor, type ProviderStartEvent } from "./providers/index.js";
import { type QueueFile, writeQueue } from "./queue.js";
import { readValidatedQueue } from "./queue-service.js";
import { queueFileFromRoadmap } from "./roadmap.js";
import type { RunSnapshot } from "./run-snapshot.js";
import { createLogDir, renderPrompt, writePrivateFile } from "./run-artifacts.js";
import { providerEnvForDeadline } from "./timeouts.js";

export interface StartupRefreshOptions {
  deadline: number | null;
  onOutput?: () => void;
  onProviderStart?: (event: ProviderStartEvent) => void;
  streamProviderOutput?: boolean;
}

export interface StartupRefreshResult {
  logDir: string;
  queueFile: QueueFile;
}

export async function refreshQueueAtRunStart(context: ProjectContext, snapshot: RunSnapshot, options: StartupRefreshOptions): Promise<StartupRefreshResult> {
  const roadmapMarkdown = await readRoadmapMarkdown(context);
  const seed = seedQueueFromRoadmap(context, roadmapMarkdown);
  await writeQueue(seed.queueFile, context);

  const logDir = await createLogDir(context, "startup-refresh");
  const prompt = await renderPrompt(context, "startup-refresh.md", {
    GOALS_MD: snapshot.goalsMarkdown,
    QUEUE_JSON: JSON.stringify(seed.queueFile, null, 2),
    QUEUE_PATH: path.relative(context.root, context.paths.queue).split(path.sep).join(path.posix.sep),
    ROADMAP_MD: roadmapMarkdown,
    ROADMAP_PARSE_STATUS: seed.parseStatus,
  });
  await writePrivateFile(path.join(logDir, "startup-refresh.prompt.md"), prompt);

  const beforeMutationFingerprint = await projectMutationFingerprint(context, { ignoredPaths: [context.paths.queue], includeIgnoredFiles: true });
  const result = await providerFor(context).run({
    agent: "build",
    context,
    env: providerEnvForDeadline(options.deadline),
    logPath: path.join(logDir, "startup-refresh.opencode.log"),
    onOutput: options.onOutput,
    onStart: options.onProviderStart,
    prompt,
    role: "startup-refresh",
    skipPermissions: context.config.dangerouslySkipPermissions,
    streamOutput: options.streamProviderOutput,
  });
  await writePrivateFile(path.join(logDir, "startup-refresh.md"), result.output);

  const afterMutationFingerprint = await projectMutationFingerprint(context, { ignoredPaths: [context.paths.queue], includeIgnoredFiles: true });
  if (beforeMutationFingerprint !== null && afterMutationFingerprint !== null && beforeMutationFingerprint !== afterMutationFingerprint) {
    await writeQueue(seed.queueFile, context);
    throw new Error("Startup refresh may only update the Roadrunner queue file.");
  }

  if (result.code !== 0) throw new Error(`Startup refresh failed (exit ${String(result.code)}).`);

  try {
    return { logDir, queueFile: await readValidatedQueue(context) };
  } catch (error) {
    await writeQueue(seed.queueFile, context);
    throw error;
  }
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
