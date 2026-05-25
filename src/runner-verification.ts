import path from "node:path";

import type { ProjectContext } from "./config.js";
import { runShell } from "./managed-process.js";
import type { QueueStep } from "./queue.js";
import { providerFor, type ProviderRunResult, type ProviderStartEvent } from "./providers/index.js";
import type { RunSnapshot } from "./run-snapshot.js";
import { renderPrompt, writePrivateFile } from "./run-artifacts.js";
import { providerEnvForDeadline, verificationTimeoutMs } from "./timeouts.js";

interface FixFailureOptions {
  deadline: number | null;
  onOutput?: () => void;
  onProviderStart?: (event: ProviderStartEvent) => void;
  signal?: AbortSignal;
  streamProviderOutput?: boolean;
}

export async function verify(
  context: ProjectContext,
  step: QueueStep,
  logDir: string,
  { deadline = null, onOutput, prefix = "verify", signal }: { deadline?: number | null; onOutput?: () => void; prefix?: string; signal?: AbortSignal } = {},
): Promise<{ ok: boolean; output: string }> {
  let output = "";

  for (const [index, command] of step.verification.entries()) {
    const result = await runShell(context, command, path.join(logDir, `${prefix}-${index + 1}.log`), `${prefix}-${index + 1}`, {
      onOutput,
      signal,
      timeoutMs: verificationTimeoutMs(deadline),
    });
    output += `$ ${command}\n${result.output}\n`;
    if (result.code !== 0) return { ok: false, output };
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
    LAST_FAILURE: failureOutput,
    PLAN_MD: planMarkdown,
    STEP_JSON: JSON.stringify(step, null, 2),
  });
  await writePrivateFile(path.join(logDir, "fix-failure.prompt.md"), prompt);

  const result = await providerFor(context).run({
    agent: "build",
    context,
    env: providerEnvForDeadline(options.deadline),
    logPath: path.join(logDir, "fix-failure.opencode.log"),
    onOutput: options.onOutput,
    onStart: options.onProviderStart,
    prompt,
    role: "fix-failure",
    signal: options.signal,
    skipPermissions: context.config.dangerouslySkipPermissions,
    streamOutput: options.streamProviderOutput,
  });
  await writePrivateFile(path.join(logDir, "fix-failure.md"), result.output);
  return result;
}
