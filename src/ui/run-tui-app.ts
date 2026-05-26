import { createRequire } from "node:module";
import type { Readable, Writable } from "node:stream";
import type { Widgets } from "blessed";
import type { ProjectContext } from "../infrastructure/config.js";
import type { QueueFile } from "../domain/queue.js";
import { escapeBlessedMarkup } from "./blessed-markup.js";
import type { RunTuiApp } from "./run-tui-app-types.js";
export type { RunTuiApp, RunTuiAppFactory } from "./run-tui-app-types.js";
import { selectedTaskIndex, taskRowsFromQueue, taskStats, taskTableData, type TaskRow, type TaskStats } from "./run-dashboard-model.js";
import { discoverTaskLogs, readLogTail, type TaskLogFile } from "./run-log-discovery.js";
import { updateProgressForActivity, updateProgressForEvent, type RunProgressState } from "./run-progress.js";
import type { RunSessionLogger } from "./run-session-log.js";
import type { RunTuiAction, RunTuiFailure } from "./run-tui-actions.js";
import { createRunTuiActionQueue } from "./run-tui-action-queue.js";
import { promptForDirective } from "./run-tui-directive-input.js";
import { createRunTuiElements, setFocusBorders } from "./run-tui-elements.js";
import { bindRunTuiKeys } from "./run-tui-keymap.js";
import { nextFocus, previousFocus, type FocusPanel } from "./run-tui-navigation.js";
import { eventMessage, eventPayload } from "./run-tui-events.js";
import { actionText, createDisplayState, currentDisplayState as viewDisplayState, detailsText, failureActionText, headerText, logViewerText, renderFailureModal, type RunDisplayState, type RunDisplayStatus } from "./run-tui-view.js";
import type { RoadrunnerRunActivityEvent, RoadrunnerRunControl, RoadrunnerRunEvent } from "../application/runner.js";
const require = createRequire(import.meta.url);
const blessed = require("blessed") as typeof import("blessed");
/* v8 ignore start -- blessed full-screen rendering requires an interactive TTY; pure state, log, and session helpers are covered separately. */
export async function createTuiApp(context: ProjectContext, session: RunSessionLogger, options: { input: Readable; now: () => number; output: Writable }): Promise<RunTuiApp> {
  let control: RoadrunnerRunControl | null = null;
  let focus: FocusPanel = "tasks";
  let logFiles: TaskLogFile[] = [];
  let logText = "Select a task log and press Enter.";
  let pendingRestart = false;
  let activeFailure: RunTuiFailure | null = null;
  let progress: RunProgressState | null = null;
  let rows: TaskRow[] = [];
  let selectedLogIndex = 0;
  let selectedLogPath: string | null = null;
  let selectedTaskId: string | null = null;
  let baseDisplay: RunDisplayState = displayState("STARTING", "Loading Roadrunner state.");
  let stats: TaskStats = { blocked: 0, current: 0, done: 0, next: 0 };
  let status = `Session log: ${session.sessionLogPath}`;
  let pendingStop = false;
  let stopping = false;
  const actionQueue = createRunTuiActionQueue();
  const elements = createRunTuiElements(blessed, options.input, options.output);
  const { actions, details, footer, header, log, logs, modal, screen, table } = elements;
  bindRunTuiKeys(screen, {
    cleanup: () => enqueueAction({ type: "cleanup" }),
    confirmRestart: (yes) => confirmRestart(yes),
    directive: () => promptForDirective(blessed, screen, (text) => enqueueAction({ text, type: "add-directive" })),
    down: () => (focus === "logs" ? moveLog(1) : focus === "log" ? scrollLog(1) : moveTask(1)),
    enter: () => openSelectedLog(),
    exit: () => requestExit(),
    focusBack: () => setFocus(previousFocus(focus)),
    focusNext: () => setFocus(nextFocus(focus)),
    pageDown: () => scrollLog(10),
    pageUp: () => scrollLog(-10),
    pauseOrPlay: () => requestPauseOrPlay(),
    reconcile: () => enqueueAction({ type: "reconcile" }),
    restart: () => (activeFailure ? chooseFailureAction("restart-task") : requestRestart()),
    up: () => (focus === "logs" ? moveLog(-1) : focus === "log" ? scrollLog(-1) : moveTask(-1)),
    viewLogs: () => activeFailure && chooseFailureAction("view-logs"),
  });
  const timer = setInterval(() => {
    void refreshOpenLog(false);
    render();
  }, 1_000);

  await refreshLogs();
  render();
  return {
    onActivity(event) {
      progress = updateProgressForActivity(progress, event, options.now());
      if (!progress) baseDisplay = { ...baseDisplay, lastActivityAt: options.now() };
      render();
    },
    onControl(nextControl) {
      control = nextControl;
      if (pendingStop) {
        stopFromControl();
        render();
      }
    },
    onEvent(event) {
      session.event(event.type, eventMessage(event), eventPayload(event));
      progress = updateProgressForEvent(progress, event, options.now());
      if (event.type === "step") selectedTaskId = event.step.id;
      if (event.type === "provider-start") selectedLogPath = event.logPath;
      if (event.type === "queue-updated") updateQueue(event.queueFile);
      if (event.type === "validate") baseDisplay = displayState("VALIDATING", "Checking project and provider configuration.");
      if (event.type === "startup-refresh") baseDisplay = displayState("REFRESHING QUEUE", "Refreshing queue from roadmap and repository state.");
      if (event.type === "run-stop-requested") {
        baseDisplay = displayState("STOPPING", "Stopping run and cleaning Roadrunner-owned processes.");
        status = "Stopping run and cleaning Roadrunner-owned processes.";
      }
      if (event.type === "task-restart-requested") status = `Restart requested for ${event.step.id}.`;
      if (event.type === "task-auto-restart-requested") status = `Auto restart ${event.restart}/${event.maxRestarts} for ${event.step.id}.`;
      if (event.type === "task-auto-restart-limit-exceeded") status = `Auto restart limit exceeded for ${event.step.id}.`;
      refreshLogsAndRender();
      render();
    },
    setStatus(nextStatus) {
      status = nextStatus;
      activeFailure = null;
      pendingRestart = false;
      pendingStop = false;
      stopping = false;
      baseDisplay = displayState(nextStatus.startsWith("Run failed:") ? "FAILED" : nextStatus.startsWith("Completed") || nextStatus.startsWith("Stopped") ? "DONE" : baseDisplay.status, nextStatus);
      render();
    },
    showFailure(failure) {
      activeFailure = failure;
      status = failure.message;
      baseDisplay = displayState("FAILED", failure.message);
      render();
    },
    stop() {
      clearInterval(timer);
      screen.destroy();
    },
    waitForAction() {
      return actionQueue.wait();
    },
  };
  function updateQueue(queueFile: QueueFile): void {
    rows = taskRowsFromQueue(queueFile);
    stats = taskStats(queueFile);
    const index = selectedTaskIndex(rows, selectedTaskId);
    selectedTaskId = index >= 0 ? rows[index]!.id : null;
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
    log.setContent(escapeBlessedMarkup(logViewerText(selectedLogFile, logText)));
    actions.setContent(failureActionText(activeFailure) ?? actionText(restartableProgress, pendingRestart, stopping));
    footer.setContent(` ${escapeBlessedMarkup(status)}`);
    renderFailureModal(modal, activeFailure);
    setFocusBorders(elements, focus);
    screen.render();
  }
  function moveTask(delta: number): void {
    if (rows.length === 0) return;
    const index = selectedTaskIndex(rows, selectedTaskId);
    selectedTaskId = rows[Math.max(0, Math.min(rows.length - 1, index + delta))]!.id;
    session.event("task-selected", `selected task ${selectedTaskId}`, { taskId: selectedTaskId });
    refreshLogsAndRender(true);
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
  function requestPauseOrPlay(): void {
    if (progress || stopping) {
      pendingRestart = false;
      stopping = true;
      stopFromControl();
      enqueueAction({ type: "pause" });
      return;
    }
    enqueueAction({ type: "play" });
    status = "Starting Roadrunner run.";
    baseDisplay = displayState("STARTING", status);
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
    if (stopping && !pendingStop) return;
    pendingRestart = false;
    stopping = true;
    if (control) stopFromControl();
    else {
      pendingStop = true;
      status = "Stop requested before runner control was ready.";
      baseDisplay = displayState("STOPPING", status);
      session.event("stop-requested", status, { source: "tui" });
    }
    render();
  }
  function requestExit(): void {
    if (progress || control || baseDisplay.status === "STARTING" || baseDisplay.status === "VALIDATING" || baseDisplay.status === "REFRESHING QUEUE") requestStop();
    enqueueAction({ type: "exit" });
  }
  function stopFromControl(): void {
    const ok = control?.stopRun() ?? false;
    pendingStop = !ok;
    stopping = ok || pendingStop;
    status = ok ? "Stopping run and cleaning Roadrunner-owned processes." : "Stop requested before runner control was ready.";
    baseDisplay = displayState("STOPPING", status);
    session.event("stop-requested", status, { source: "tui" });
  }
  function refreshLogsAndRender(showErrors = false): void {
    void refreshLogs()
      .then(render)
      .catch((error: Error) => {
        if (showErrors) status = `Log error: ${error.message}`;
        session.event("log-refresh-error", `log refresh failed: ${error.message}`, { message: error.message });
        render();
      });
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
  function chooseFailureAction(type: "restart-task" | "view-logs"): void {
    activeFailure = null;
    enqueueAction({ type });
    render();
  }
  function enqueueAction(action: RunTuiAction): void {
    actionQueue.enqueue(action);
  }
  function currentDisplayState(): RunDisplayState {
    return viewDisplayState({ baseDisplay, now: options.now(), progress, row: selectedRow(), status, stopping });
  }
  function displayState(nextStatus: RunDisplayStatus, message: string | null): RunDisplayState {
    return createDisplayState(nextStatus, message, selectedRow(), options.now());
  }
}
/* v8 ignore stop */
