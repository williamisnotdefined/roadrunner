import { formatDuration } from "./duration.js";
import { parseNonNegativeIntegerValue } from "./numeric-options.js";

export const defaultAutoRestartIdleMs = 10 * 60 * 1000;
export const defaultMaxAutoRestartsPerStep = 10;

export interface AutoRestartConfig {
  autoRestartIdleMs?: number;
  maxAutoRestartsPerStep?: number;
}

export interface AutoRestartPolicy {
  enabled: boolean;
  idleMs: number;
  maxRestarts: number;
}

export function resolveAutoRestartPolicy(config: AutoRestartConfig, env: NodeJS.ProcessEnv = process.env): AutoRestartPolicy {
  const idleMs = parseNonNegativeIntegerValue("ROADRUNNER_AUTO_RESTART_IDLE_MS", env.ROADRUNNER_AUTO_RESTART_IDLE_MS, config.autoRestartIdleMs ?? defaultAutoRestartIdleMs);
  const maxRestarts = parseNonNegativeIntegerValue(
    "ROADRUNNER_MAX_AUTO_RESTARTS_PER_STEP",
    env.ROADRUNNER_MAX_AUTO_RESTARTS_PER_STEP,
    config.maxAutoRestartsPerStep ?? defaultMaxAutoRestartsPerStep,
  );

  return { enabled: idleMs > 0 && maxRestarts > 0, idleMs, maxRestarts };
}

export function automaticRestartBlockedReason(policy: AutoRestartPolicy): string {
  return `Provider idle for ${formatDuration(policy.idleMs)} after ${policy.maxRestarts} automatic restarts.`;
}
