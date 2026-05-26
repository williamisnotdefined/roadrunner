import path from "node:path";

import type { ProjectContext } from "../infrastructure/config.js";
import { formatStep, type QueueStep } from "../domain/queue.js";
import { providerFor, type ProviderStartEvent } from "../infrastructure/providers/index.js";
import type { RunSnapshot } from "./run-snapshot.js";
import { createLogDir, renderPrompt, writePrivateFile } from "../infrastructure/run-artifacts.js";
import { providerEnvForDeadline } from "../domain/timeouts.js";

export interface PlanOptions {
  deadline?: number | null;
  onOutput?: () => void;
  onProviderStart?: (event: ProviderStartEvent) => void;
  signal?: AbortSignal;
  streamProviderOutput?: boolean;
}

export interface PlanStepResult {
  logDir: string;
  result: { code: number | null; output: string };
  step: QueueStep;
}

export async function planStep(context: ProjectContext, step: QueueStep, snapshot: RunSnapshot, options: PlanOptions): Promise<PlanStepResult> {
  const logDir = await createLogDir(context, `${step.id}-plan`);
  const prompt = await renderPrompt(context, "plan-step.md", {
    GOALS_MD: snapshot.goalsMarkdown,
    ROADMAP_STATUS: formatStep(step),
    STEP_JSON: JSON.stringify(step, null, 2),
  });

  await writePrivateFile(path.join(logDir, "plan.prompt.md"), prompt);
  const result = await providerFor(context).run({
    agent: "plan",
    context,
    env: providerEnvForDeadline(options.deadline),
    logPath: path.join(logDir, "plan.opencode.log"),
    onOutput: options.onOutput,
    onStart: options.onProviderStart,
    prompt,
    role: "plan",
    signal: options.signal,
    streamOutput: options.streamProviderOutput,
    workspaceAccess: "read-only",
  });

  await writePrivateFile(path.join(logDir, "plan.md"), result.output);

  return { logDir, result, step };
}
