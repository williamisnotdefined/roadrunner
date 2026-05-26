import path from "node:path";

import type { ProjectContext } from "../infrastructure/config.js";
import { formatStep, type QueueStep } from "../domain/queue.js";
import type { ProviderStartEvent } from "../infrastructure/providers/index.js";
import type { RunSnapshot } from "./run-snapshot.js";
import { createLogDir, renderPrompt, writePrivateFile } from "../infrastructure/run-artifacts.js";
import { runProviderRole } from "./provider-runner.js";
import { planMarkdownFromOutput } from "./plan-output.js";

export interface PlanOptions {
  deadline?: number | null;
  onOutput?: () => void;
  onProviderStart?: (event: ProviderStartEvent) => void;
  operatorDirective?: string | null;
  signal?: AbortSignal;
  streamProviderOutput?: boolean;
}

export interface PlanStepResult {
  logDir: string;
  planMarkdown: string | null;
  result: { code: number | null; output: string };
  step: QueueStep;
}

export async function planStep(context: ProjectContext, step: QueueStep, snapshot: RunSnapshot, options: PlanOptions): Promise<PlanStepResult> {
  const logDir = await createLogDir(context, `${step.id}-plan`);
  const prompt = await renderPrompt(context, "plan-step.md", {
    GOALS_MD: snapshot.goalsMarkdown,
    OPERATOR_DIRECTIVE_MD: snapshot.operatorDirectiveMarkdown,
    ROADMAP_STATUS: formatStep(step),
    STEP_JSON: JSON.stringify(step, null, 2),
  });

  await writePrivateFile(path.join(logDir, "plan.prompt.md"), prompt);
  const result = await runProviderRole(context, {
    agent: "plan",
    deadline: options.deadline,
    logPath: path.join(logDir, "plan.opencode.log"),
    onOutput: options.onOutput,
    onProviderStart: options.onProviderStart,
    prompt,
    role: "plan",
    signal: options.signal,
    streamProviderOutput: options.streamProviderOutput,
    workspaceAccess: "read-only",
  });

  await writePrivateFile(path.join(logDir, "plan.md"), result.output);
  const planMarkdown = result.code === 0 ? planMarkdownFromOutput(result.output) : null;
  if (planMarkdown !== null) await writePrivateFile(path.join(logDir, "plan.clean.md"), `${planMarkdown}\n`);

  return { logDir, planMarkdown, result, step };
}
