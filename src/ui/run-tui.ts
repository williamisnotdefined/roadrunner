import type { Readable, Writable } from "node:stream";
import { setTimeout as sleep } from "node:timers/promises";

import type { ProjectContext } from "../infrastructure/config.js";
import { createRunSessionLogger, type RunSessionLogger } from "./run-session-log.js";
import { createTuiApp, type RunTuiAppFactory } from "./run-tui-app.js";
import { run, type RunOptions } from "../application/runner.js";
type RunTuiRunner = (context: ProjectContext, options: RunOptions) => Promise<number>;

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
    session.event("run-start", `run started root=${context.root} queue=${context.paths.queue}`, { queuePath: context.paths.queue, root: context.root });
    const completed = await (options.runner ?? run)(context, {
      maxHours: options.maxHours,
      maxSteps: options.maxSteps,
      onActivity: app.onActivity,
      onControl: app.onControl,
      onEvent: (event) => {
        if (event.type === "run-stop-requested") stopRequested = true;
        app?.onEvent(event);
      },
      streamProviderOutput: false,
    });
    const finalStatus = stopRequested ? `Stopped after ${completed} completed step(s). Session log: ${session.sessionLogPath}` : `Completed ${completed} step(s). Session log: ${session.sessionLogPath}`;
    app.setStatus(finalStatus);
    session.event("run-end", stopRequested ? `run stopped completed=${completed}` : `run ended completed=${completed}`, { completed, stopped: stopRequested });
    await sleep(options.settleMs ?? 500);
    return completed;
  } catch (error) {
    app?.setStatus(`Run failed: ${(error as Error).message}`);
    session.event("error", `run failed: ${(error as Error).message}`, { message: (error as Error).message, stack: (error as Error).stack });
    await sleep(options.settleMs ?? 500);
    throw error;
  } finally {
    app?.stop();
    await session.close();
  }
}

function isTty(stream: unknown): boolean {
  return Boolean((stream as { isTTY?: boolean }).isTTY);
}
