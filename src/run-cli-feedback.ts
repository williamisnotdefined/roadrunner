import { createInterface, type Interface } from "node:readline";

import chalk from "chalk";

import type { RoadrunnerRunActivityEvent, RoadrunnerRunControl, RoadrunnerRunEvent, RoadrunnerRunPhase } from "./runner.js";

const defaultIntervalMs = 1_000;

interface ProgressTerminal {
  clearLine(direction: -1 | 0 | 1): void;
  cursorTo(x: number): void;
  write(message: string): void;
}

export interface RunFeedback {
  beforeEvent(): void;
  onActivity(event: RoadrunnerRunActivityEvent): void;
  onControl(control: RoadrunnerRunControl): void;
  onEvent(event: RoadrunnerRunEvent): void;
  stop(): void;
}

export interface RunFeedbackOptions {
  input?: NodeJS.ReadableStream;
  interactive?: boolean;
  intervalMs?: number;
  now?: () => number;
  stdout: (message: string) => void;
  terminal?: ProgressTerminal;
}

export interface RunProgressState {
  attempt: number;
  lastActivityAt: number;
  logPath: string | null;
  phase: RoadrunnerRunPhase;
  phaseStartedAt: number;
  pid: number | null;
  stepId: string;
  taskStartedAt: number;
}

export function createRunFeedback({ input = process.stdin, interactive = Boolean(process.stdout.isTTY && process.stdin.isTTY), intervalMs = defaultIntervalMs, now = () => Date.now(), stdout, terminal = process.stdout }: RunFeedbackOptions): RunFeedback {
  let control: RoadrunnerRunControl | null = null;
  let interval: NodeJS.Timeout | undefined;
  let lineVisible = false;
  let progress: RunProgressState | null = null;
  let readlineInterface: Interface | undefined;
  let stopped = false;

  const clearProgressLine = () => {
    if (!interactive || !lineVisible) return;
    terminal.clearLine(0);
    terminal.cursorTo(0);
    lineVisible = false;
  };

  const renderProgressLine = () => {
    if (!interactive) return;
    if (!progress) {
      clearProgressLine();
      return;
    }

    terminal.clearLine(0);
    terminal.cursorTo(0);
    terminal.write(formatRunProgress(progress, now()));
    lineVisible = true;
  };

  const startProgressTimer = () => {
    if (!interactive || interval) return;
    interval = setInterval(renderProgressLine, intervalMs);
  };

  const setPhase = (phase: RoadrunnerRunPhase) => {
    if (!progress) return;
    const timestamp = now();
    progress = { ...progress, lastActivityAt: timestamp, logPath: null, phase, phaseStartedAt: timestamp, pid: null };
    renderProgressLine();
  };

  if (interactive) {
    stdout(`${chalk.blue("[control]")} type ${chalk.bold("rstask")} + Enter to restart the current task`);
    readlineInterface = createInterface({ input, terminal: false });
    readlineInterface.on("line", (line) => {
      if (line.trim() !== "rstask") return;
      clearProgressLine();
      if (!control?.restartCurrentTask()) stdout(`${chalk.yellow("[control]")} no active task attempt to restart`);
    });
  }

  return {
    beforeEvent: clearProgressLine,
    onActivity(event) {
      if (progress?.stepId === event.step.id && progress.phase === event.phase) progress = { ...progress, lastActivityAt: now() };
    },
    onControl(nextControl) {
      control = nextControl;
    },
    onEvent(event) {
      const timestamp = now();
      if (event.type === "step") {
        progress = { attempt: 1, lastActivityAt: timestamp, logPath: null, phase: "plan", phaseStartedAt: timestamp, pid: null, stepId: event.step.id, taskStartedAt: timestamp };
        startProgressTimer();
      } else if (event.type === "plan" || event.type === "implement" || event.type === "fix" || event.type === "reconcile") {
        setPhase(event.type);
      } else if (event.type === "verify") {
        setPhase(event.attempt === "fixed" ? "verify-fixed" : "verify");
      } else if (event.type === "provider-start" && progress?.stepId === event.step.id) {
        progress = { ...progress, lastActivityAt: timestamp, logPath: event.logPath, pid: event.pid };
      } else if (event.type === "task-restart") {
        progress = { attempt: event.attempt, lastActivityAt: timestamp, logPath: null, phase: "plan", phaseStartedAt: timestamp, pid: null, stepId: event.step.id, taskStartedAt: timestamp };
      } else if (event.type === "step-complete" || event.type === "cleanup") {
        progress = null;
      }
      renderProgressLine();
    },
    stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(interval);
      readlineInterface?.close();
      clearProgressLine();
    },
  };
}

export function formatRunProgress(state: RunProgressState, now: number): string {
  const parts = [
    `${chalk.magenta("[doing]")} ${chalk.bold(state.phase)} ${state.stepId}`,
    `attempt=${state.attempt}`,
    `elapsed=${formatDuration(now - state.taskStartedAt)}`,
    `phase=${formatDuration(now - state.phaseStartedAt)}`,
    `idle=${formatDuration(now - state.lastActivityAt)}`,
  ];
  if (state.pid !== null) parts.push(`pid=${state.pid}`);
  if (state.logPath !== null) parts.push(`log=${state.logPath}`);
  return parts.join(" ");
}

export function formatDuration(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(durationMs / 1000));
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);

  if (hours > 0) return `${hours}h${String(minutes).padStart(2, "0")}m${String(seconds).padStart(2, "0")}s`;
  if (totalMinutes > 0) return `${totalMinutes}m${String(seconds).padStart(2, "0")}s`;
  return `${seconds}s`;
}
