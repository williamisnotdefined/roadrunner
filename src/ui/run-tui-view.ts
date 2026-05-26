import type { TaskRow, TaskStats } from "./run-dashboard-model.js";
import { escapeBlessedMarkup } from "./blessed-markup.js";
import type { RunProgressState } from "./run-progress.js";
import type { RunSessionLogger } from "./run-session-log.js";
import type { RunTuiFailure } from "./run-tui-actions.js";
import { formatDuration } from "../domain/duration.js";
import type { RoadrunnerRunPhase } from "../application/runner.js";

export type RunDisplayStatus = "STARTING" | "IDLE" | "VALIDATING" | "REFRESHING QUEUE" | "PLANNING" | "IMPLEMENTING" | "VERIFYING" | "FIXING" | "RECONCILING" | "STOPPING" | "DONE" | "FAILED";

const statusByPhase: Record<RoadrunnerRunPhase, RunDisplayStatus> = {
  fix: "FIXING",
  implement: "IMPLEMENTING",
  plan: "PLANNING",
  reconcile: "RECONCILING",
  "startup-refresh": "REFRESHING QUEUE",
  verify: "VERIFYING",
  "verify-fixed": "VERIFYING",
};

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
  const runControl = progress ? "{yellow-fg}[p/Space] Pause{/yellow-fg}" : "{cyan-fg}[p/Space] Play{/cyan-fg}";
  const restart = progress ? "{cyan-fg}[r] ↻ Restart Task{/cyan-fg}" : "{gray-fg}[r] Restart unavailable{/gray-fg}";
  return ` ${runControl}   ${restart}   [i] Directive   [R] Reconcile   [c] Cleanup   {red-fg}[q/Ctrl+C] Exit{/red-fg}   [Tab/Shift+Tab] panels   [Enter] log`;
}

export function createDisplayState(nextStatus: RunDisplayStatus, message: string | null, row: TaskRow | null, now: number): RunDisplayState {
  return { attempt: null, lastActivityAt: now, logPath: null, message, pid: null, startedAt: now, status: nextStatus, stepId: row?.id ?? null, title: row?.title ?? null };
}

export function currentDisplayState(input: { baseDisplay: RunDisplayState; now: number; progress: RunProgressState | null; row: TaskRow | null; status: string; stopping: boolean }): RunDisplayState {
  if (input.baseDisplay.status === "DONE" || input.baseDisplay.status === "FAILED") return input.baseDisplay;
  if (input.stopping) return input.baseDisplay.status === "STOPPING" ? input.baseDisplay : createDisplayState("STOPPING", input.status, input.row, input.now);
  if (input.progress) return displayStateFromProgress(input.progress, input.row);
  return { ...input.baseDisplay, stepId: input.baseDisplay.stepId ?? input.row?.id ?? null, title: input.baseDisplay.title ?? input.row?.title ?? null };
}

export function failureActionText(failure: RunTuiFailure | null): string | null {
  if (!failure) return null;
  const detailsText = failure.details.length > 0 ? ` ${escapeBlessedMarkup(failure.details.join(" | "))}` : "";
  return ` {red-fg}${escapeBlessedMarkup(failure.title)}{/red-fg}:${detailsText}  {cyan-fg}[Enter/Esc] Close{/cyan-fg}  [r] Restart task  [l] View logs  [c] Cleanup  [q] Exit`;
}

export function failureModalText(failure: RunTuiFailure): string {
  const details = failure.details.length > 0 ? `\n${failure.details.map((detail) => `- ${escapeBlessedMarkup(detail)}`).join("\n")}` : "";
  return `{red-fg}{bold}${escapeBlessedMarkup(failure.title)}{/bold}{/red-fg}\n${escapeBlessedMarkup(failure.message)}${details}\n\n[Enter/Esc] Close   [r] Restart task   [l] View logs   [c] Cleanup   [q] Exit`;
}

export function renderFailureModal(modal: { hide(): void; setContent(content: string): void; show(): void }, failure: RunTuiFailure | null): void {
  if (!failure) {
    modal.hide();
    return;
  }
  modal.setContent(failureModalText(failure));
  modal.show();
}

export function logViewerText(file: { label: string; relativePath: string } | null, text: string): string {
  if (!file) return text || "Select a task log and press Enter.";
  const content = text.length > 0 ? text : "Waiting for provider output...";
  return `Viewing: ${file.label}\nPath: ${file.relativePath}\n\n${content}`;
}

function statusFromPhase(phase: RunProgressState["phase"]): RunDisplayStatus {
  return statusByPhase[phase];
}
