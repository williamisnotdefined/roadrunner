import { formatDuration } from "../domain/duration.js";
import type { RoadrunnerRunActivityEvent, RoadrunnerRunEvent, RoadrunnerRunPhase } from "../application/runner.js";

export interface RunProgressState {
  attempt: number;
  lastActivityAt: number;
  logPath: string | null;
  phase: RoadrunnerRunPhase;
  phaseStartedAt: number;
  pid: number | null;
  stepId: string | null;
  taskStartedAt: number;
}

type ProgressEventHandler<T extends RoadrunnerRunEvent["type"]> = (
  progress: RunProgressState | null,
  event: Extract<RoadrunnerRunEvent, { type: T }>,
  now: number,
) => RunProgressState | null;

const progressEventHandlers: Partial<{ [Type in RoadrunnerRunEvent["type"]]: ProgressEventHandler<Type> }> = {
  cleanup: () => null,
  fix: (progress, _event, now) => setPhase(progress, "fix", now),
  implement: (progress, _event, now) => setPhase(progress, "implement", now),
  plan: (progress, _event, now) => setPhase(progress, "plan", now),
  "provider-start": (progress, event, now) => {
    if (!progress || (event.step ? progress.stepId !== event.step.id : progress.phase !== "startup-refresh")) return progress;
    return { ...progress, lastActivityAt: now, logPath: event.logPath, pid: event.pid };
  },
  reconcile: (progress, _event, now) => setPhase(progress, "reconcile", now),
  step: (_progress, event, now) => startProgress(event.step.id, 1, "plan", now),
  "step-complete": () => null,
  "startup-refresh": (_progress, _event, now) => startProgress(null, 1, "startup-refresh", now),
  "task-restart": (_progress, event, now) => startProgress(event.step.id, event.attempt, "plan", now),
  verify: (progress, event, now) => setPhase(progress, event.attempt === "fixed" ? "verify-fixed" : "verify", now),
};

export function updateProgressForActivity(progress: RunProgressState | null, event: RoadrunnerRunActivityEvent, now: number): RunProgressState | null {
  if (!progress || progress.phase !== event.phase) return progress;
  if (event.step && progress.stepId !== event.step.id) return progress;
  return { ...progress, lastActivityAt: now };
}

export function updateProgressForEvent(progress: RunProgressState | null, event: RoadrunnerRunEvent, now: number): RunProgressState | null {
  const handler = progressEventHandlers[event.type] as ((currentProgress: RunProgressState | null, nextEvent: RoadrunnerRunEvent, timestamp: number) => RunProgressState | null) | undefined;
  return handler ? handler(progress, event, now) : progress;
}

export function formatRunProgress(state: RunProgressState, now: number): string {
  const parts = [
    state.stepId ? `${state.phase} ${state.stepId}` : state.phase,
    `attempt=${state.attempt}`,
    `elapsed=${formatDuration(now - state.taskStartedAt)}`,
    `phase=${formatDuration(now - state.phaseStartedAt)}`,
    `idle=${formatDuration(now - state.lastActivityAt)}`,
  ];
  if (state.pid !== null) parts.push(`pid=${state.pid}`);
  if (state.logPath !== null) parts.push(`log=${state.logPath}`);
  return parts.join(" ");
}

function startProgress(stepId: string | null, attempt: number, phase: RoadrunnerRunPhase, now: number): RunProgressState {
  return { attempt, lastActivityAt: now, logPath: null, phase, phaseStartedAt: now, pid: null, stepId, taskStartedAt: now };
}

function setPhase(progress: RunProgressState | null, phase: RoadrunnerRunPhase, now: number): RunProgressState | null {
  if (!progress) return progress;
  return { ...progress, lastActivityAt: now, logPath: null, phase, phaseStartedAt: now, pid: null };
}
