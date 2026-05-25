import { describe, expect, test } from "vitest";
import { PassThrough } from "node:stream";

import { loadContext } from "../src/config.js";
import type { QueueStep } from "../src/queue.js";
import { runWithTui } from "../src/run-tui.js";
import { createTuiApp } from "../src/run-tui-app.js";
import { actionText, detailsText, headerText } from "../src/run-tui-view.js";
import type { RoadrunnerRunControl, RunOptions } from "../src/runner.js";
import { createInitializedProject, removeDir, tempDir } from "./helpers.js";

describe("run TUI", () => {
  test("requires an interactive terminal", async () => {
    const directory = await tempDir("roadrunner-tui-nontty-");
    try {
      const context = await loadContext(directory, { _: [] });
      await expect(runWithTui(context, { isInteractive: false })).rejects.toThrow(/requires an interactive terminal/);
    } finally {
      await removeDir(directory);
    }
  });

  test("runs through the TUI app and writes session events", async () => {
    const directory = await tempDir("roadrunner-tui-success-");
    const events: string[] = [];
    const statuses: string[] = [];
    let stopped = false;
    let runnerOptions: RunOptions | null = null;
    try {
      const context = await loadContext(directory, { _: [] });
      const completed = await runWithTui(context, {
        appFactory: async () => ({
          onActivity: () => {},
          onControl: () => {},
          onEvent: () => {},
          setStatus: (status) => statuses.push(status),
          stop: () => {
            stopped = true;
          },
        }),
        input: new PassThrough(),
        isInteractive: true,
        output: new PassThrough(),
        runner: async (_context, options) => {
          runnerOptions = options;
          options.onControl?.(restartControl);
          options.onEvent?.({ type: "validate" });
          return 2;
        },
        sessionLogger: fakeLogger(events),
        settleMs: 0,
      });

      expect(completed).toBe(2);
      expect(runnerOptions).toMatchObject({ streamProviderOutput: false });
      expect(statuses).toEqual(["Completed 2 step(s). Session log: session.log"]);
      expect(stopped).toBe(true);
      expect(events).toContain("run-start:run started root=" + directory + " queue=" + context.paths.queue);
      expect(events).toContain("run-end:run ended completed=2");
    } finally {
      await removeDir(directory);
    }
  });

  test("detects interactive streams when no explicit terminal flag is provided", async () => {
    const directory = await tempDir("roadrunner-tui-detect-tty-");
    try {
      const context = await loadContext(directory, { _: [] });
      const input = ttyStream();
      const output = ttyStream();

      await expect(
        runWithTui(context, {
          appFactory: async () => ({
            onActivity: () => {},
            onControl: () => {},
            onEvent: () => {},
            setStatus: () => {},
            stop: () => {},
          }),
          input,
          output,
          runner: async () => 0,
          sessionLogger: fakeLogger([]),
          settleMs: 0,
        }),
      ).resolves.toBe(0);
    } finally {
      await removeDir(directory);
    }
  });

  test("reports cooperative stop through the TUI app", async () => {
    const directory = await tempDir("roadrunner-tui-stop-");
    const events: string[] = [];
    const statuses: string[] = [];
    try {
      const context = await loadContext(directory, { _: [] });
      const completed = await runWithTui(context, {
        appFactory: async () => ({
          onActivity: () => {},
          onControl: () => {},
          onEvent: () => {},
          setStatus: (status) => statuses.push(status),
          stop: () => {},
        }),
        input: new PassThrough(),
        isInteractive: true,
        output: new PassThrough(),
        runner: async (_context, options) => {
          options.onEvent?.({ type: "run-stop-requested" });
          return 0;
        },
        sessionLogger: fakeLogger(events),
        settleMs: 0,
      });

      expect(completed).toBe(0);
      expect(statuses).toEqual(["Stopped after 0 completed step(s). Session log: session.log"]);
      expect(events).toContain("run-end:run stopped completed=0");
    } finally {
      await removeDir(directory);
    }
  });

  test("creates the real blessed TUI app", async () => {
    const directory = await tempDir("roadrunner-tui-real-app-");
    try {
      const context = await createInitializedProject(directory);
      const app = await createTuiApp(context, fakeLogger([]), { input: ttyStream(), now: () => 1_000, output: ttyStream() });

      app.setStatus("ready");
      app.stop();
    } finally {
      await removeDir(directory);
    }
  });

  test("formats current task duration without runner progress", () => {
    const currentTask = { observedAt: 1_000, stepId: "sample-step" };
    const row = taskRow("current");

    expect(headerText({ blocked: 0, current: 1, done: 2, next: 3 }, null, currentTask, 61_000)).toContain("current sample-step for=1m00s");
    expect(detailsText(row, null, currentTask, 61_000, fakeLogger([]))).toContain("current for: 1m00s");
  });

  test("formats TUI details and actions for progress states", () => {
    const progress = {
      attempt: 2,
      lastActivityAt: 1_000,
      logPath: null,
      phase: "implement" as const,
      phaseStartedAt: 500,
      pid: null,
      stepId: "sample-step",
      taskStartedAt: 0,
    };
    const blockedRow = taskRow("blocked", { blockedReason: "needs attention" });

    expect(headerText({ blocked: 0, current: 0, done: 0, next: 0 }, progress, null, 70_000)).toContain("implement sample-step attempt=2");
    expect(headerText({ blocked: 0, current: 0, done: 0, next: 0 }, null, null, 70_000)).not.toContain("for=");
    expect(detailsText(null, null, null, 70_000, fakeLogger([]))).toBe("No tasks.");
    expect(detailsText(taskRow("current"), progress, null, 70_000, fakeLogger([]))).toContain("possibly stalled");
    expect(detailsText(blockedRow, null, null, 70_000, fakeLogger([]))).toContain("blocked: needs attention");
    expect(actionText(progress, false, false)).toContain("Restart Task");
    expect(actionText(null, true, false)).toContain("Restart current task? y/N");
    expect(actionText(null, false, true)).toContain("Stopping run and cleaning");
    expect(actionText(null, false, false)).toContain("Restart unavailable");
  });

  test("creates a real session log when no logger is injected", async () => {
    const directory = await tempDir("roadrunner-tui-real-session-");
    try {
      const context = await loadContext(directory, { _: [] });
      await expect(
        runWithTui(context, {
          appFactory: async () => ({
            onActivity: () => {},
            onControl: () => {},
            onEvent: () => {},
            setStatus: () => {},
            stop: () => {},
          }),
          input: new PassThrough(),
          isInteractive: true,
          output: new PassThrough(),
          runner: async () => 0,
          settleMs: 0,
        }),
      ).resolves.toBe(0);
    } finally {
      await removeDir(directory);
    }
  });

  test("reports run failures through the TUI app", async () => {
    const directory = await tempDir("roadrunner-tui-failure-");
    const events: string[] = [];
    const statuses: string[] = [];
    try {
      const context = await loadContext(directory, { _: [] });
      await expect(
        runWithTui(context, {
          appFactory: async () => ({
            onActivity: () => {},
            onControl: () => {},
            onEvent: () => {},
            setStatus: (status) => statuses.push(status),
            stop: () => {},
          }),
          input: new PassThrough(),
          isInteractive: true,
          output: new PassThrough(),
          runner: async () => {
            throw new Error("boom");
          },
          sessionLogger: fakeLogger(events),
          settleMs: 0,
        }),
      ).rejects.toThrow(/boom/);

      expect(statuses).toEqual(["Run failed: boom"]);
      expect(events).toContain("error:run failed: boom");
    } finally {
      await removeDir(directory);
    }
  });
});

const restartControl: RoadrunnerRunControl = {
  restartCurrentTask: () => false,
  stopRun: () => false,
};

const step: QueueStep = {
  acceptance: ["works"],
  id: "sample-step",
  phase: "Sample",
  prompt: "Build it.",
  scope: ["src/sample.ts"],
  title: "Ship Sample",
  verification: ["npm test"],
};

function taskRow(status: "blocked" | "current", stepOverrides: Partial<QueueStep> = {}) {
  return {
    icon: status === "current" ? "▶" : "!",
    id: "sample-step",
    phase: "Sample",
    status,
    statusLabel: status === "current" ? "Now" : "Blocked",
    step: { ...step, ...stepOverrides },
    title: "Ship Sample",
  };
}

function fakeLogger(events: string[]) {
  return {
    eventsLogPath: "events.ndjson",
    logDir: "logs",
    sessionLogPath: "session.log",
    close: async () => {},
    event: (type: string, message: string) => {
      events.push(`${type}:${message}`);
    },
  };
}

function ttyStream(): PassThrough & { columns: number; isTTY: boolean; rows: number } {
  const stream = new PassThrough() as PassThrough & { columns: number; isTTY: boolean; rows: number };
  stream.columns = 120;
  stream.isTTY = true;
  stream.rows = 40;
  return stream;
}
