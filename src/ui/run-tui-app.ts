import { createRequire } from "node:module";
import type { Readable, Writable } from "node:stream";

import type { Widgets } from "blessed";

import type { ProjectContext } from "../infrastructure/config.js";
import type { QueueFile } from "../domain/queue.js";
import { readValidatedQueue } from "../application/queue-service.js";
import { escapeBlessedMarkup } from "./blessed-markup.js";
import { selectedTaskIndex, taskRowsFromQueue, taskStats, taskTableData, type TaskRow, type TaskStats } from "./run-dashboard-model.js";
import { discoverTaskLogs, readLogTail, type TaskLogFile } from "./run-log-discovery.js";
import { updateProgressForActivity, updateProgressForEvent, type RunProgressState } from "./run-progress.js";
import type { RunSessionLogger } from "./run-session-log.js";
import { nextFocus, previousFocus, type FocusPanel } from "./run-tui-navigation.js";
import { actionText, detailsText, displayStateFromProgress, headerText, type RunDisplayState, type RunDisplayStatus } from "./run-tui-view.js";
import type { RoadrunnerRunActivityEvent, RoadrunnerRunControl, RoadrunnerRunEvent } from "../application/runner.js";

export interface RunTuiApp {
  onActivity(event: RoadrunnerRunActivityEvent): void;
  onControl(control: RoadrunnerRunControl): void;
  onEvent(event: RoadrunnerRunEvent): void;
  setStatus(status: string): void;
  stop(): void;
}

export type RunTuiAppFactory = (context: ProjectContext, session: RunSessionLogger, options: { input: Readable; now: () => number; output: Writable }) => Promise<RunTuiApp>;

const require = createRequire(import.meta.url);
const blessed = require("blessed") as typeof import("blessed");

/* v8 ignore start -- blessed full-screen rendering requires an interactive TTY; pure state, log, and session helpers are covered separately. */
export async function createTuiApp(context: ProjectContext, session: RunSessionLogger, options: { input: Readable; now: () => number; output: Writable }): Promise<RunTuiApp> {
  let control: RoadrunnerRunControl | null = null;
  let focus: FocusPanel = "tasks";
  let logFiles: TaskLogFile[] = [];
  let logText = "Select a task log and press Enter.";
  let pendingRestart = false;
  let progress: RunProgressState | null = null;
  let rows: TaskRow[] = [];
  let selectedLogIndex = 0;
  let selectedLogPath: string | null = null;
  let selectedTaskId: string | null = null;
  let baseDisplay: RunDisplayState = displayState("STARTING", "Loading Roadrunner state.");
  let stats: TaskStats = { blocked: 0, current: 0, done: 0, next: 0 };
  let status = `Session log: ${session.sessionLogPath}`;
  let stopping = false;

  const screen = blessed.screen({ fullUnicode: true, input: options.input as never, output: options.output as never, smartCSR: true, title: "Roadrunner" });
  const header = blessed.box({ height: 3, left: 0, tags: true, top: 0, width: "100%" });
  const table = blessed.listtable({ border: "line", height: "45%", keys: false, left: 0, mouse: true, pad: 1, tags: true, top: 3, width: "100%" });
  const details = blessed.box({ border: "line", height: "35%", label: " Details ", left: 0, tags: true, top: "48%", width: "38%" });
  const logs = blessed.list({ border: "line", height: "35%", keys: false, label: " Logs ", left: "38%", mouse: true, tags: true, top: "48%", width: "25%" });
  const log = blessed.box({ alwaysScroll: true, border: "line", height: "35%", label: " Log Viewer ", left: "63%", mouse: true, scrollable: true, scrollbar: { ch: " ", track: { bg: "black" }, style: { bg: "cyan" } }, tags: true, top: "48%", vi: true, width: "37%" });
  const actions = blessed.box({ bottom: 1, height: 1, left: 0, mouse: true, tags: true, width: "100%" });
  const footer = blessed.box({ bottom: 0, height: 1, left: 0, tags: true, width: "100%" });

  for (const element of [header, table, details, logs, log, actions, footer]) screen.append(element);
  screen.enableMouse();
  screen.key(["tab"], () => setFocus(nextFocus(focus)));
  screen.key(["S-tab", "backtab"], () => setFocus(previousFocus(focus)));
  screen.key(["up", "k"], () => (focus === "logs" ? moveLog(-1) : focus === "log" ? scrollLog(-1) : moveTask(-1)));
  screen.key(["down", "j"], () => (focus === "logs" ? moveLog(1) : focus === "log" ? scrollLog(1) : moveTask(1)));
  screen.key(["pageup"], () => scrollLog(-10));
  screen.key(["pagedown"], () => scrollLog(10));
  screen.key(["enter"], () => openSelectedLog());
  screen.key(["r"], () => requestRestart());
  screen.key(["q", "C-c", "C-q"], () => requestStop());
  screen.key(["y", "Y"], () => confirmRestart(true));
  screen.key(["n", "N", "escape"], () => confirmRestart(false));
  actions.on("click", () => requestRestart());

  const timer = setInterval(() => {
    void refreshOpenLog(false);
    render();
  }, 1_000);

  await refreshQueue();
  render();

  return {
    onActivity(event) {
      progress = updateProgressForActivity(progress, event, options.now());
      if (!progress) baseDisplay = { ...baseDisplay, lastActivityAt: options.now() };
      render();
    },
    onControl(nextControl) {
      control = nextControl;
    },
    onEvent(event) {
      session.event(event.type, eventMessage(event), eventPayload(event));
      progress = updateProgressForEvent(progress, event, options.now());
      if (event.type === "step") selectedTaskId = event.step.id;
      if (event.type === "provider-start") selectedLogPath = event.logPath;
      if (event.type === "validate") baseDisplay = displayState("VALIDATING", "Checking project and provider configuration.");
      if (event.type === "startup-refresh") baseDisplay = displayState("REFRESHING QUEUE", "Refreshing queue from roadmap and repository state.");
      if (event.type === "run-stop-requested") {
        baseDisplay = displayState("STOPPING", "Stopping run and cleaning Roadrunner-owned processes.");
        status = "Stopping run and cleaning Roadrunner-owned processes.";
      }
      if (event.type === "task-restart-requested") status = `Restart requested for ${event.step.id}.`;
      if (event.type === "task-auto-restart-requested") status = `Auto restart ${event.restart}/${event.maxRestarts} for ${event.step.id}.`;
      if (event.type === "task-auto-restart-limit-exceeded") status = `Auto restart limit exceeded for ${event.step.id}.`;
      void refreshQueue();
      void refreshLogs();
      render();
    },
    setStatus(nextStatus) {
      status = nextStatus;
      baseDisplay = displayState(nextStatus.startsWith("Run failed:") ? "FAILED" : nextStatus.startsWith("Completed") || nextStatus.startsWith("Stopped") ? "DONE" : baseDisplay.status, nextStatus);
      render();
    },
    stop() {
      clearInterval(timer);
      screen.destroy();
    },
  };

  async function refreshQueue(): Promise<void> {
    try {
      const queueFile: QueueFile = await readValidatedQueue(context);
      rows = taskRowsFromQueue(queueFile);
      stats = taskStats(queueFile);
      const index = selectedTaskIndex(rows, selectedTaskId);
      selectedTaskId = index >= 0 ? rows[index]!.id : null;
      await refreshLogs();
    } catch (error) {
      status = `Queue error: ${(error as Error).message}`;
      session.event("ui-error", status);
    }
  }

  async function refreshLogs(): Promise<void> {
    const row = selectedRow();
    const activeLogPath = progress?.logPath ?? selectedLogPath;
    if (!row && !activeLogPath) {
      logFiles = [];
      selectedLogPath = null;
      logText = "No task selected.";
      return;
    }
    logFiles = await discoverTaskLogs(context, row?.id ?? "", activeLogPath);
    const index = selectedLogPath ? logFiles.findIndex((file) => file.path === selectedLogPath) : -1;
    selectedLogIndex = index >= 0 ? index : Math.max(0, logFiles.findIndex((file) => file.path === progress?.logPath));
    selectedLogPath = logFiles[selectedLogIndex]?.path ?? null;
    await refreshOpenLog(false);
  }

  async function refreshOpenLog(showErrors = true): Promise<void> {
    if (!selectedLogPath) return;
    try {
      logText = await readLogTail(selectedLogPath);
    } catch (error) {
      if (showErrors) status = `Log error: ${(error as Error).message}`;
    }
  }

  function render(): void {
    const display = currentDisplayState();
    const selectedLogFile = logFiles[selectedLogIndex] ?? null;
    const activeLogLabel = logFiles.find((file) => file.active)?.label ?? selectedLogFile?.label ?? null;
    const restartableProgress = progress?.stepId ? progress : null;
    header.setContent(headerText(display, options.now()));
    table.setData(taskTableData(rows, selectedTaskId, stats));
    const taskIndex = selectedTaskIndex(rows, selectedTaskId);
    if (taskIndex >= 0) table.select(taskIndex + 1);
    details.setContent(detailsText(selectedRow(), display, stats, options.now(), session, activeLogLabel));
    logs.setItems(logFiles.map((file, index) => `${index === selectedLogIndex ? "›" : " "} ${escapeBlessedMarkup(file.label)}`));
    if (logFiles.length > 0) logs.select(selectedLogIndex);
    log.setContent(escapeBlessedMarkup(logViewerText(selectedLogFile)));
    actions.setContent(actionText(restartableProgress, pendingRestart, stopping));
    footer.setContent(` ${escapeBlessedMarkup(status)}`);
    setBorders();
    screen.render();
  }

  function moveTask(delta: number): void {
    if (rows.length === 0) return;
    const index = selectedTaskIndex(rows, selectedTaskId);
    selectedTaskId = rows[Math.max(0, Math.min(rows.length - 1, index + delta))]!.id;
    session.event("task-selected", `selected task ${selectedTaskId}`, { taskId: selectedTaskId });
    void refreshLogs().then(render);
  }

  function moveLog(delta: number): void {
    if (logFiles.length === 0) return;
    selectedLogIndex = Math.max(0, Math.min(logFiles.length - 1, selectedLogIndex + delta));
    selectedLogPath = logFiles[selectedLogIndex]!.path;
    void refreshOpenLog().then(render);
  }

  function openSelectedLog(): void {
    if (focus !== "logs" || logFiles.length === 0) return;
    selectedLogPath = logFiles[selectedLogIndex]!.path;
    session.event("log-opened", `opened log ${selectedLogPath}`, { logPath: selectedLogPath });
    setFocus("log");
    void refreshOpenLog().then(render);
  }

  function requestRestart(): void {
    if (!progress?.stepId || !control) {
      status = "No active task attempt to restart.";
      render();
      return;
    }
    pendingRestart = true;
    status = `Restart ${progress.stepId ?? "current task"}? Press y to confirm or n to cancel.`;
    session.event("restart-requested", `restart requested for ${progress.stepId}`, { source: "tui", stepId: progress.stepId });
    render();
  }

  function confirmRestart(yes: boolean): void {
    if (!pendingRestart) return;
    pendingRestart = false;
    if (!yes) {
      status = "Restart cancelled.";
      session.event("restart-cancelled", "restart cancelled", { source: "tui" });
      render();
      return;
    }
    const ok = control?.restartCurrentTask() ?? false;
    status = ok ? "Restarting current task from planning." : "No active task attempt to restart.";
    session.event("restart-confirmed", status, { source: "tui" });
    render();
  }

  function requestStop(): void {
    if (stopping) return;
    stopping = true;
    pendingRestart = false;
    const ok = control?.stopRun() ?? false;
    status = ok ? "Stopping run and cleaning Roadrunner-owned processes." : "Stop requested before runner control was ready.";
    baseDisplay = displayState("STOPPING", status);
    session.event("stop-requested", status, { source: "tui" });
    render();
  }

  function setFocus(nextFocus: FocusPanel): void {
    focus = nextFocus;
    render();
  }

  function scrollLog(offset: number): void {
    (log as Widgets.BoxElement & { scroll(offset: number): void }).scroll(offset);
    render();
  }

  function selectedRow(): TaskRow | null {
    const index = selectedTaskIndex(rows, selectedTaskId);
    return index >= 0 ? rows[index]! : null;
  }

  function setBorders(): void {
    table.style.border = { fg: focus === "tasks" ? "cyan" : "gray" };
    logs.style.border = { fg: focus === "logs" ? "cyan" : "gray" };
    log.style.border = { fg: focus === "log" ? "cyan" : "gray" };
  }

  function currentDisplayState(): RunDisplayState {
    if (baseDisplay.status === "DONE" || baseDisplay.status === "FAILED") return baseDisplay;
    if (stopping) return baseDisplay.status === "STOPPING" ? baseDisplay : displayState("STOPPING", status);
    const row = selectedRow();
    if (progress) return displayStateFromProgress(progress, row);
    return { ...baseDisplay, stepId: baseDisplay.stepId ?? row?.id ?? null, title: baseDisplay.title ?? row?.title ?? null };
  }

  function displayState(nextStatus: RunDisplayStatus, message: string | null): RunDisplayState {
    const now = options.now();
    return { attempt: null, lastActivityAt: now, logPath: null, message, pid: null, startedAt: now, status: nextStatus, stepId: selectedRow()?.id ?? null, title: selectedRow()?.title ?? null };
  }

  function logViewerText(file: TaskLogFile | null): string {
    if (!file) return logText || "Select a task log and press Enter.";
    const content = logText.length > 0 ? logText : "Waiting for provider output...";
    return `Viewing: ${file.label}\nPath: ${file.relativePath}\n\n${content}`;
  }
}

function eventMessage(event: RoadrunnerRunEvent): string {
  if (event.type === "provider-start") return `provider started role=${event.role} pid=${event.pid ?? "n/a"} log=${event.logPath}`;
  if ("step" in event && event.step) return `${event.type} ${event.step.id}`;
  return event.type;
}

function eventPayload(event: RoadrunnerRunEvent): Record<string, unknown> {
  if ("step" in event && event.step) return { stepId: event.step.id };
  return {};
}
/* v8 ignore stop */
