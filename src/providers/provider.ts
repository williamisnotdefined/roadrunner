import type { ProjectContext } from "../config.js";

export interface ProviderRunInput {
  agent: string;
  context: ProjectContext;
  env?: Record<string, string>;
  logPath: string;
  onOutput?: () => void;
  onStart?: (event: ProviderStartEvent) => void;
  prompt: string;
  role: string;
  signal?: AbortSignal;
  skipPermissions?: boolean;
}

export interface ProviderStartEvent {
  command: string[];
  debug: boolean;
  logPath: string;
  pid: number | null;
  role: string;
}

export interface ProviderRunResult {
  code: number | null;
  output: string;
}

export interface Provider {
  run(input: ProviderRunInput): Promise<ProviderRunResult>;
}
