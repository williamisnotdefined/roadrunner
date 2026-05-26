import type { QueueStep } from "../domain/queue.js";
import type { AutoRestartPolicy } from "../domain/restart-policy.js";
import type { RoadrunnerRunEvent, RoadrunnerRunPhase } from "./runner.js";

export type AttemptRestartReason =
  | { type: "manual" }
  | { idleMs: number; maxRestarts: number; restart: number; type: "auto" }
  | { idleMs: number; maxRestarts: number; type: "auto-limit" };

export interface RestartableAttemptState {
  abortController: AbortController;
  lastActivityAt: number;
  phase: RoadrunnerRunPhase | null;
  restartReason: AttemptRestartReason | null;
  restartRequested: boolean;
  startedAt: number;
  step: QueueStep;
}

interface AutoRestartWatchdogInput {
  current: RestartableAttemptState;
  emitEvent: (event: RoadrunnerRunEvent) => void;
  incrementRestartCount: () => number;
  policy: AutoRestartPolicy;
  restartCount: () => number;
}

export function recordAttemptActivity(current: RestartableAttemptState): void {
  current.lastActivityAt = Date.now();
}

export function startAutoRestartWatchdog({ current, emitEvent, incrementRestartCount, policy, restartCount }: AutoRestartWatchdogInput): () => void {
  if (!policy.enabled) return () => {};

  let stopped = false;
  let timeout: NodeJS.Timeout | undefined;

  const schedule = (delayMs: number) => {
    timeout = setTimeout(checkIdle, Math.max(1, delayMs));
  };

  const stop = () => {
    stopped = true;
    clearTimeout(timeout);
  };

  const requestAutoRestart = (idleMs: number) => {
    if (restartCount() >= policy.maxRestarts) {
      current.restartReason = { idleMs, maxRestarts: policy.maxRestarts, type: "auto-limit" };
      current.restartRequested = true;
      emitEvent({ idleMs, maxRestarts: policy.maxRestarts, phase: current.phase, step: current.step, type: "task-auto-restart-limit-exceeded" });
      current.abortController.abort();
      return;
    }

    const restart = incrementRestartCount();
    current.restartReason = { idleMs, maxRestarts: policy.maxRestarts, restart, type: "auto" };
    current.restartRequested = true;
    emitEvent({ idleMs, maxRestarts: policy.maxRestarts, phase: current.phase, restart, step: current.step, type: "task-auto-restart-requested" });
    current.abortController.abort();
  };

  const checkIdle = () => {
    if (stopped || current.restartRequested) return;
    if (!isProviderPhase(current.phase)) {
      schedule(policy.idleMs);
      return;
    }
    const idleMs = Date.now() - current.lastActivityAt;
    if (idleMs >= policy.idleMs) {
      requestAutoRestart(idleMs);
      return;
    }
    schedule(policy.idleMs - idleMs);
  };

  schedule(policy.idleMs);
  return stop;
}

function isProviderPhase(phase: RoadrunnerRunPhase | null): boolean {
  return phase === "plan" || phase === "implement" || phase === "fix";
}
