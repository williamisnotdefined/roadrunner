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

export function updateProgressForActivity(progress: RunProgressState | null, event: RoadrunnerRunActivityEvent, now: number): RunProgressState | null {
  if (!progress || progress.phase !== event.phase) return progress;
  if (event.step && progress.stepId !== event.step.id) return progress;
  return { ...progress, lastActivityAt: now };
}

export function updateProgressForEvent(progress: RunProgressState | null, event: RoadrunnerRunEvent, now: number): RunProgressState | null {
  if (event.type === "startup-refresh") return startProgress(null, 1, "startup-refresh", now);
  if (event.type === "step") return startProgress(event.step.id, 1, "plan", now);
  if (event.type === "plan" || event.type === "implement" || event.type === "fix" || event.type === "reconcile") return setPhase(progress, event.type, now);
  if (event.type === "verify") return setPhase(progress, event.attempt === "fixed" ? "verify-fixed" : "verify", now);
  if (event.type === "provider-start" && progress && (event.step ? progress.stepId === event.step.id : progress.phase === "startup-refresh")) {
    return { ...progress, lastActivityAt: now, logPath: event.logPath, pid: event.pid };
  }
  if (event.type === "task-restart") return startProgress(event.step.id, event.attempt, "plan", now);
  if (event.type === "step-complete" || event.type === "cleanup") return null;
  return progress;
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
