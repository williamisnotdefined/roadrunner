import type { ProjectContext } from "../infrastructure/config.js";
import { providerFor, type ProviderRunResult, type ProviderStartEvent } from "../infrastructure/providers/index.js";
import { providerEnvForDeadline } from "../domain/timeouts.js";

interface ProviderRoleRunInput {
  agent: string;
  bypassProviderPermissions?: boolean;
  deadline?: number | null;
  logPath: string;
  onOutput?: () => void;
  onProviderStart?: (event: ProviderStartEvent) => void;
  prompt: string;
  role: string;
  signal?: AbortSignal;
  streamProviderOutput?: boolean;
  workspaceAccess: "read-only" | "write";
}

export async function runProviderRole(context: ProjectContext, input: ProviderRoleRunInput): Promise<ProviderRunResult> {
  return providerFor(context).run({
    agent: input.agent,
    bypassProviderPermissions: input.bypassProviderPermissions,
    context,
    env: providerEnvForDeadline(input.deadline),
    logPath: input.logPath,
    onOutput: input.onOutput,
    onStart: input.onProviderStart,
    prompt: input.prompt,
    role: input.role,
    signal: input.signal,
    streamOutput: input.streamProviderOutput,
    workspaceAccess: input.workspaceAccess,
  });
}
