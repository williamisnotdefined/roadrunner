import type { QueueStep } from "../domain/queue.js";
import { automaticRestartBlockedReason, type AutoRestartPolicy } from "../domain/restart-policy.js";
import type { RoadrunnerRunPhase } from "./runner.js";

export class AutomaticRestartLimitExceededError extends Error {
  readonly blockedReason: string;
  readonly idleMs: number;
  readonly maxRestarts: number;
  readonly phase: RoadrunnerRunPhase | null;
  readonly step: QueueStep;

  constructor(input: { idleMs: number; maxRestarts: number; phase: RoadrunnerRunPhase | null; policy: AutoRestartPolicy; step: QueueStep }) {
    super(`Automatic restart limit exceeded for ${input.step.id}.`);
    this.name = "AutomaticRestartLimitExceededError";
    this.blockedReason = automaticRestartBlockedReason(input.policy);
    this.idleMs = input.idleMs;
    this.maxRestarts = input.maxRestarts;
    this.phase = input.phase;
    this.step = input.step;
  }
}

export function isAutomaticRestartLimitExceeded(error: unknown): error is AutomaticRestartLimitExceededError {
  return error instanceof AutomaticRestartLimitExceededError;
}
