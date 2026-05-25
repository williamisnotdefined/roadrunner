import type { TaskRow, TaskStats } from "./run-dashboard-model.js";
import { formatRunProgress, type RunProgressState } from "./run-progress.js";
import type { RunSessionLogger } from "./run-session-log.js";
import { formatDuration } from "./duration.js";

export interface CurrentTaskObservation {
  observedAt: number;
  stepId: string;
}

export function headerText(stats: TaskStats, progress: RunProgressState | null, currentTask: CurrentTaskObservation | null, now: number): string {
  const heartbeat = progress ? `  ${formatRunProgress(progress, now)}` : currentTask ? `  current ${currentTask.stepId} for=${formatDuration(now - currentTask.observedAt)}` : "";
  return `{bold}Roadrunner{/bold}  RUNNING  done ${stats.done}  current ${stats.current}  next ${stats.next}  blocked ${stats.blocked}${heartbeat}\n`;
}

export function detailsText(row: TaskRow | null, progress: RunProgressState | null, currentTask: CurrentTaskObservation | null, now: number, session: RunSessionLogger): string {
  if (!row) return "No tasks.";
  const lines = [`{bold}${row.icon} ${row.id}{/bold}`, `status: ${row.statusLabel}`, `phase: ${row.phase}`, `title: ${row.title}`];
  if (row.status === "current" && row.id === currentTask?.stepId) lines.push(`current for: ${formatDuration(now - currentTask.observedAt)}`);
  if (row.id === progress?.stepId) {
    lines.push(`attempt: ${progress.attempt}`, `elapsed: ${formatDuration(now - progress.taskStartedAt)}`, `idle: ${formatDuration(now - progress.lastActivityAt)}`);
    if (now - progress.lastActivityAt > 60_000) lines.push("{yellow-fg}status: possibly stalled, press r to restart{/yellow-fg}");
  }
  if (row.step.blockedReason) lines.push(`blocked: ${row.step.blockedReason}`);
  lines.push("", `session: ${session.sessionLogPath}`);
  return lines.join("\n");
}

export function actionText(progress: RunProgressState | null, pendingRestart: boolean, stopping: boolean): string {
  if (stopping) return " {yellow-fg}Stopping run and cleaning Roadrunner-owned processes...{/yellow-fg}";
  if (pendingRestart) return " {yellow-fg}Restart current task? y/N{/yellow-fg}";
  const restart = progress ? "{cyan-fg}[r] ↻ Restart Task{/cyan-fg}" : "{gray-fg}[r] Restart unavailable{/gray-fg}";
  return ` ${restart}   {red-fg}[q/Ctrl+C] Stop & Cleanup{/red-fg}   [Tab] switch panel   [Enter] open log   [PgUp/PgDn] scroll`;
}
