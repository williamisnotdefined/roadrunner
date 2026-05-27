import type { ProjectContext } from "../config.js";
import type { ProcessTreeRoot } from "../process-tree.js";

export type WorkspaceAccess = "read-only" | "write";

export interface ProviderRunInput {
  agent: string;
  bypassProviderPermissions?: boolean;
  context: ProjectContext;
  env?: Record<string, string>;
  logPath: string;
  onOutput?: () => void;
  onStart?: (event: ProviderStartEvent) => void;
  prompt: string;
  role: string;
  signal?: AbortSignal;
  streamOutput?: boolean;
  workspaceAccess: WorkspaceAccess;
}

export interface ProviderStartEvent {
  command: string[];
  debug: boolean;
  logPath: string;
  pid: number | null;
  processTreeRoot: ProcessTreeRoot | null;
  role: string;
}

export interface ProviderRunResult {
  code: number | null;
  output: string;
}

export interface Provider {
  run(input: ProviderRunInput): Promise<ProviderRunResult>;
}
