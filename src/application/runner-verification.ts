import path from "node:path";

import type { ProjectContext } from "../infrastructure/config.js";
import { runShell } from "../infrastructure/managed-process.js";
import type { QueueStep } from "../domain/queue.js";
import type { ProviderRunResult, ProviderStartEvent } from "../infrastructure/providers/index.js";
import type { RunSnapshot } from "./run-snapshot.js";
import { renderPrompt, writePrivateFile } from "../infrastructure/run-artifacts.js";
import { verificationTimeoutMs } from "../domain/timeouts.js";
import { runProviderRole } from "./provider-runner.js";

interface FixFailureOptions {
  deadline: number | null;
  onOutput?: () => void;
  onProviderStart?: (event: ProviderStartEvent) => void;
  signal?: AbortSignal;
  streamProviderOutput?: boolean;
}

export interface VerificationFailure {
  code: number | null;
  command: string;
  index: number;
  logPath: string;
}

export type VerificationResult = { ok: true; output: string } | { failedCommand: VerificationFailure; ok: false; output: string };

export async function verify(
  context: ProjectContext,
  step: QueueStep,
  logDir: string,
  { deadline = null, onOutput, prefix = "verify", signal }: { deadline?: number | null; onOutput?: () => void; prefix?: string; signal?: AbortSignal } = {},
): Promise<VerificationResult> {
  let output = "";

  for (const [index, command] of step.verification.entries()) {
    const logPath = path.join(logDir, `${prefix}-${index + 1}.log`);
    const result = await runShell(context, command, logPath, `${prefix}-${index + 1}`, {
      onOutput,
      signal,
      timeoutMs: verificationTimeoutMs(deadline),
    });
    output += `$ ${command}\n${result.output}\n`;
    if (result.code !== 0) return { failedCommand: { code: result.code, command, index, logPath }, ok: false, output };
  }

  return { ok: true, output };
}

export async function fixFailure(
  context: ProjectContext,
  step: QueueStep,
  snapshot: RunSnapshot,
  planMarkdown: string,
  failureOutput: string,
  logDir: string,
  options: FixFailureOptions,
): Promise<ProviderRunResult> {
  const prompt = await renderPrompt(context, "fix-failure.md", {
    GOALS_MD: snapshot.goalsMarkdown,
    OPERATOR_DIRECTIVE_MD: snapshot.operatorDirectiveMarkdown,
    LAST_FAILURE: failureOutput,
    PLAN_MD: planMarkdown,
    STEP_JSON: JSON.stringify(step, null, 2),
  });
  await writePrivateFile(path.join(logDir, "fix-failure.prompt.md"), prompt);

  const result = await runProviderRole(context, {
    agent: "build",
    deadline: options.deadline,
    logPath: path.join(logDir, "fix-failure.opencode.log"),
    onOutput: options.onOutput,
    onProviderStart: options.onProviderStart,
    prompt,
    role: "fix-failure",
    signal: options.signal,
    streamProviderOutput: options.streamProviderOutput,
    workspaceAccess: "write",
    bypassProviderPermissions: context.config.dangerouslySkipPermissions,
  });
  await writePrivateFile(path.join(logDir, "fix-failure.md"), result.output);
  return result;
}
