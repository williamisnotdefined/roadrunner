import type { TaskRow, TaskStats } from "./run-dashboard-model.js";
import { escapeBlessedMarkup } from "./blessed-markup.js";
import type { RunProgressState } from "./run-progress.js";
import type { RunSessionLogger } from "./run-session-log.js";
import { formatDuration } from "../domain/duration.js";

export type RunDisplayStatus = "STARTING" | "VALIDATING" | "REFRESHING QUEUE" | "PLANNING" | "IMPLEMENTING" | "VERIFYING" | "FIXING" | "RECONCILING" | "STOPPING" | "DONE" | "FAILED";

export interface RunDisplayState {
  attempt: number | null;
  lastActivityAt: number;
  logPath: string | null;
  message: string | null;
  pid: number | null;
  startedAt: number;
  status: RunDisplayStatus;
  stepId: string | null;
  title: string | null;
}

export function displayStateFromProgress(progress: RunProgressState, row: TaskRow | null): RunDisplayState {
  return {
    attempt: progress.phase === "startup-refresh" ? null : progress.attempt,
    lastActivityAt: progress.lastActivityAt,
    logPath: progress.logPath,
    message: null,
    pid: progress.pid,
    startedAt: progress.taskStartedAt,
    status: statusFromPhase(progress.phase),
    stepId: progress.stepId ?? row?.id ?? null,
    title: row?.title ?? null,
  };
}

export function headerText(display: RunDisplayState, now: number): string {
  const stale = now - display.lastActivityAt > 60_000 && display.status !== "DONE" && display.status !== "FAILED";
  const parts = ["{bold}Roadrunner{/bold}", stale ? "{yellow-fg}STALLED{/yellow-fg}" : `{cyan-fg}${display.status}{/cyan-fg}`];
  if (display.stepId) parts.push(escapeBlessedMarkup(display.stepId));
  if (display.attempt !== null) parts.push(`attempt ${display.attempt}`);
  if (display.pid !== null) parts.push(`pid ${display.pid}`);
  parts.push(`elapsed ${formatDuration(now - display.startedAt)}`);
  parts.push(`idle ${formatDuration(now - display.lastActivityAt)}`);
  if (display.message) parts.push(escapeBlessedMarkup(display.message));
  return `${parts.join("  ")}\n`;
}

export function detailsText(row: TaskRow | null, display: RunDisplayState, stats: TaskStats, now: number, session: RunSessionLogger, activeLogLabel: string | null): string {
  const lines = [`State: ${display.status}`];
  if (display.stepId) lines.push(`Task: ${escapeBlessedMarkup(display.stepId)}`);
  if (display.title) lines.push(`Title: ${escapeBlessedMarkup(display.title)}`);
  if (row) lines.push(`Roadmap phase: ${escapeBlessedMarkup(row.phase)}`);
  if (display.attempt !== null) lines.push(`Attempt: ${display.attempt}`);
  lines.push(`Elapsed: ${formatDuration(now - display.startedAt)}`, `Idle: ${formatDuration(now - display.lastActivityAt)}`);
  if (display.pid !== null) lines.push(`PID: ${display.pid}`);
  if (activeLogLabel) lines.push(`Active log: ${escapeBlessedMarkup(activeLogLabel)}`);
  if (now - display.lastActivityAt > 60_000 && display.status !== "DONE" && display.status !== "FAILED") lines.push("{yellow-fg}Status: possibly stalled, press r to restart{/yellow-fg}");
  lines.push(`Queue: ${stats.done} done · ${stats.current} active · ${stats.next} waiting · ${stats.blocked} blocked`);
  if (row?.step.blockedReason) lines.push(`Blocked: ${escapeBlessedMarkup(row.step.blockedReason)}`);
  lines.push("", `Session: ${escapeBlessedMarkup(session.sessionLogPath)}`);
  return lines.join("\n");
}

export function actionText(progress: RunProgressState | null, pendingRestart: boolean, stopping: boolean): string {
  if (stopping) return " {yellow-fg}Stopping run and cleaning Roadrunner-owned processes...{/yellow-fg}";
  if (pendingRestart) return " {yellow-fg}Restart current task? y/N{/yellow-fg}";
  const restart = progress ? "{cyan-fg}[r] ↻ Restart Task{/cyan-fg}" : "{gray-fg}[r] Restart unavailable{/gray-fg}";
  return ` ${restart}   {red-fg}[q/Ctrl+C] Stop & Cleanup{/red-fg}   [Tab/Shift+Tab] switch panel   [Enter] open log   [PgUp/PgDn] scroll`;
}

function statusFromPhase(phase: RunProgressState["phase"]): RunDisplayStatus {
  if (phase === "startup-refresh") return "REFRESHING QUEUE";
  if (phase === "plan") return "PLANNING";
  if (phase === "implement") return "IMPLEMENTING";
  if (phase === "verify" || phase === "verify-fixed") return "VERIFYING";
  if (phase === "fix") return "FIXING";
  return "RECONCILING";
}
