import type { Readable, Writable } from "node:stream";
import { setTimeout as sleep } from "node:timers/promises";
import path from "node:path";

import type { QueueFile } from "../domain/queue.js";
import type { ProjectContext } from "../infrastructure/config.js";
import { cleanupProcesses } from "../infrastructure/process-registry.js";
import { acquireProjectLock } from "../infrastructure/lock.js";
import { writePrivateFile } from "../infrastructure/run-artifacts.js";
import { reconcileProjectQueue } from "../application/global-reconciliation.js";
import { isAutomaticRestartLimitExceeded } from "../application/run-errors.js";
import { readRunSnapshot } from "../application/run-snapshot.js";
import { createRunSessionLogger, type RunSessionLogger } from "./run-session-log.js";
import { createTuiApp, type RunTuiAppFactory } from "./run-tui-app.js";
import type { RunTuiAction, RunTuiFailure } from "./run-tui-actions.js";
import { run, type RunOptions } from "../application/runner.js";
type RunTuiRunner = (context: ProjectContext, options: RunOptions) => Promise<number>;

interface RunTuiSessionState {
  operatorDirective: string | null;
  queueFile: QueueFile | null;
  queueOverride: QueueFile | null;
}

export interface RunTuiOptions {
  input?: Readable;
  isInteractive?: boolean;
  maxHours?: number;
  maxSteps?: number;
  now?: () => number;
  output?: Writable;
  settleMs?: number;
  /** @internal test seam for the full-screen renderer. */
  appFactory?: RunTuiAppFactory;
  /** @internal test seam for the run loop. */
  runner?: RunTuiRunner;
  /** @internal test seam for session log writes. */
  sessionLogger?: RunSessionLogger;
}

export async function runWithTui(context: ProjectContext, options: RunTuiOptions = {}): Promise<number> {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const isInteractive = options.isInteractive ?? Boolean(isTty(input) && isTty(output));
  if (!isInteractive) throw new Error("roadrunner run requires an interactive terminal.");

  const session = options.sessionLogger ?? (await createRunSessionLogger(context));
  /* v8 ignore next -- the default app factory starts blessed and is exercised manually in a real TTY. */
  const appFactory = options.appFactory ?? createTuiApp;
  let app: Awaited<ReturnType<RunTuiAppFactory>> | null = null;
  let stopRequested = false;

  try {
    app = await appFactory(context, session, { input, now: options.now ?? (() => Date.now()), output });
    session.event("run-start", `run started root=${context.root}`, { root: context.root });
    let lastCompleted = 0;
    let lastError: unknown;
    const state: RunTuiSessionState = { operatorDirective: null, queueFile: null, queueOverride: null };
    while (true) {
      stopRequested = false;
      lastError = undefined;
      try {
        const initialQueueFile = state.queueOverride;
        state.queueOverride = null;
        lastCompleted = await runOnce(context, app, options, state.operatorDirective, initialQueueFile, (value) => {
          stopRequested = value;
        }, (queueFile) => {
          state.queueFile = queueFile;
        });
        const finalStatus = stopRequested ? `Stopped after ${lastCompleted} completed step(s). Session log: ${session.sessionLogPath}` : `Completed ${lastCompleted} step(s). Session log: ${session.sessionLogPath}`;
        app.setStatus(finalStatus);
        session.event("run-end", stopRequested ? `run stopped completed=${lastCompleted}` : `run ended completed=${lastCompleted}`, { completed: lastCompleted, stopped: stopRequested });
      } catch (error) {
        lastError = error;
        app.showFailure(failureFromError(error));
        session.event("error", `run failed: ${(error as Error).message}`, { message: (error as Error).message, stack: (error as Error).stack });
      }

      const action = await waitForRunnableAction(app, context, session, state);
      if (action.type === "exit") {
        await sleep(options.settleMs ?? 500);
        if (lastError) throw lastError;
        return lastCompleted;
      }
      app.setStatus(action.type === "restart-task" ? "Restarting task from planning." : "Starting Roadrunner run.");
    }
  } finally {
    app?.stop();
    await session.close();
  }
}

async function runOnce(
  context: ProjectContext,
  app: Awaited<ReturnType<RunTuiAppFactory>>,
  options: RunTuiOptions,
  operatorDirective: string | null,
  initialQueueFile: QueueFile | null,
  setStopRequested: (value: boolean) => void,
  setQueueFile: (queueFile: QueueFile) => void,
): Promise<number> {
  return (options.runner ?? run)(context, {
    initialQueueFile,
    maxHours: options.maxHours,
    maxSteps: options.maxSteps,
    onActivity: app.onActivity,
    onControl: app.onControl,
    onEvent: (event) => {
      if (event.type === "run-stop-requested") setStopRequested(true);
      if (event.type === "queue-updated") setQueueFile(event.queueFile);
      app.onEvent(event);
    },
    operatorDirective,
    streamProviderOutput: false,
  });
}

async function waitForRunnableAction(app: Awaited<ReturnType<RunTuiAppFactory>>, context: ProjectContext, session: RunSessionLogger, state: RunTuiSessionState): Promise<RunTuiAction> {
  while (true) {
    const action = await app.waitForAction();
    if (action.type === "add-directive") {
      state.operatorDirective = action.text;
      await writePrivateFile(path.join(session.logDir, "operator-directive.md"), `${action.text}\n`);
      app.setStatus("Operator directive captured. Press R to reconcile or p/Space to play with it.");
      session.event("operator-directive", "operator directive captured", { source: "tui" });
      continue;
    }
    if (action.type === "cleanup") {
      const results = await cleanupProcesses(context, { force: true });
      const message = results.length === 0 ? "No Roadrunner-owned processes are registered." : `Cleaned ${results.length} Roadrunner-owned process record(s).`;
      app.setStatus(message);
      session.event("cleanup-requested", message, { source: "tui" });
      continue;
    }
    if (action.type === "reconcile") {
      await handleGlobalReconcile(app, context, session, state);
      continue;
    }
    if (action.type === "pause" || action.type === "view-logs") {
      app.setStatus(action.type === "pause" ? "Paused. Press p/Space to play or q to exit." : "Viewing logs. Press r to restart, p/Space to play, or q to exit.");
      continue;
    }
    return action;
  }
}

async function handleGlobalReconcile(app: Awaited<ReturnType<RunTuiAppFactory>>, context: ProjectContext, session: RunSessionLogger, state: RunTuiSessionState): Promise<void> {
  if (!state.queueFile) {
    app.setStatus("No queue is loaded yet. Press p/Space to start or load Roadrunner state first.");
    return;
  }
  let releaseLock: (() => Promise<void>) | null = null;
  try {
    releaseLock = await acquireProjectLock(context, "Roadrunner global reconcile");
    app.setStatus("Reconciling queue with current goals, roadmap, repository state, and operator directive.");
    const result = await reconcileProjectQueue(context, state.queueFile, await readRunSnapshot(context, { operatorDirective: state.operatorDirective }), {
      deadline: null,
      onOutput: () => app.onActivity({ phase: "reconcile" }),
      onProviderStart: (event) => app.onEvent({ ...event, type: "provider-start" }),
      streamProviderOutput: false,
    });
    state.queueFile = result.queueFile;
    state.queueOverride = result.queueFile;
    app.onEvent({ queueFile: result.queueFile, type: "queue-updated" });
    app.setStatus(`Reconciled queue. Log: ${result.logDir}`);
  } catch (error) {
    app.showFailure({ details: [], message: (error as Error).message, recoverable: true, title: "Global reconcile failed" });
    session.event("error", `global reconcile failed: ${(error as Error).message}`, { message: (error as Error).message, stack: (error as Error).stack });
  } finally {
    await releaseLock?.();
  }
}

function failureFromError(error: unknown): RunTuiFailure {
  if (isAutomaticRestartLimitExceeded(error)) {
    return {
      title: "Auto-restart limit exceeded",
      message: error.message,
      recoverable: true,
      details: [`Task: ${error.step.id}`, `Phase: ${error.phase ?? "unknown"}`, `Restarts: ${error.maxRestarts}/${error.maxRestarts}`, error.blockedReason],
    };
  }
  return { title: "Run failed", message: (error as Error).message, recoverable: false, details: [] };
}

function isTty(stream: unknown): boolean {
  return Boolean((stream as { isTTY?: boolean }).isTTY);
}
