import type { RestartableAttemptState } from "./auto-restart-watchdog.js";
import type { RoadrunnerRunControl, RoadrunnerRunEvent } from "./runner.js";

export interface CurrentAttemptState extends RestartableAttemptState {}

export interface RunControlState {
  activeAbortController: AbortController | null;
  current: CurrentAttemptState | null;
  stopRequested: boolean;
}

export function createRunControl(state: RunControlState, emitEvent: (event: RoadrunnerRunEvent) => void): RoadrunnerRunControl {
  return {
    restartCurrentTask() {
      if (state.stopRequested) return false;
      const current = state.current;
      if (!current) return false;
      if (current.restartRequested) return true;

      current.restartReason = { type: "manual" };
      current.restartRequested = true;
      emitEvent({ elapsedMs: Date.now() - current.startedAt, phase: current.phase, step: current.step, type: "task-restart-requested" });
      current.abortController.abort();
      return true;
    },
    stopRun() {
      if (state.stopRequested) return true;
      state.stopRequested = true;
      emitEvent({ type: "run-stop-requested" });
      state.current?.abortController.abort();
      state.activeAbortController?.abort();
      return true;
    },
  };
}
