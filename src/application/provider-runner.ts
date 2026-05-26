import type { ProjectContext } from "../infrastructure/config.js";
import { providerFor, type ProviderRunResult, type ProviderStartEvent } from "../infrastructure/providers/index.js";
import { providerEnvForDeadline } from "../domain/timeouts.js";
import { workspaceFingerprint, workspaceFingerprintChanges } from "../infrastructure/workspace-fingerprint.js";

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
  const before = input.workspaceAccess === "read-only" ? await workspaceFingerprint(context) : null;
  const result = await providerFor(context).run({
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
  if (before) {
    const changes = workspaceFingerprintChanges(before, await workspaceFingerprint(context));
    if (changes.length > 0) throw new Error(formatReadOnlyWorkspaceChange(input.role, changes));
  }
  return result;
}

function formatReadOnlyWorkspaceChange(role: string, changes: readonly string[]): string {
  const visibleChanges = changes.slice(0, 10);
  const hiddenCount = changes.length - visibleChanges.length;
  return [
    `Read-only provider role ${role} modified workspace files.`,
    "",
    "Roadrunner stopped because this phase is only allowed to inspect the repository.",
    "",
    "Changed files:",
    ...visibleChanges.map((change) => `- ${change}`),
    ...(hiddenCount > 0 ? [`- ...and ${hiddenCount} more`] : []),
  ].join("\n");
}
