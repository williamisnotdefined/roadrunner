import { describe, expect, test } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { PassThrough } from "node:stream";
import { setTimeout as sleep } from "node:timers/promises";

import { loadContext } from "../src/infrastructure/config.js";
import type { QueueStep } from "../src/domain/queue.js";
import { runWithTui } from "../src/ui/run-tui.js";
import { createTuiApp } from "../src/ui/run-tui-app.js";
import { eventMessage, eventPayload } from "../src/ui/run-tui-events.js";
import { nextFocus, previousFocus } from "../src/ui/run-tui-navigation.js";
import { actionText, detailsText, displayStateFromProgress, headerText, type RunDisplayState } from "../src/ui/run-tui-view.js";
import type { RoadrunnerRunControl, RunOptions } from "../src/application/runner.js";
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
          showFailure: (failure) => statuses.push(failure.message),
          stop: () => {
            stopped = true;
          },
          waitForAction: async () => ({ type: "exit" as const }),
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
      expect(events).toContain("run-start:run started root=" + directory);
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
            showFailure: () => {},
            stop: () => {},
            waitForAction: async () => ({ type: "exit" as const }),
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
          showFailure: (failure) => statuses.push(failure.message),
          stop: () => {},
          waitForAction: async () => ({ type: "exit" as const }),
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

  test("renders provider logs that look like blessed markup", async () => {
    const directory = await tempDir("roadrunner-tui-raw-log-");
    let app: Awaited<ReturnType<typeof createTuiApp>> | null = null;
    try {
      const context = await createInitializedProject(directory);
      const logDir = path.join(context.paths.logs, "001-first-step");
      await mkdir(logDir, { recursive: true });
      await writeFile(path.join(logDir, "provider.log"), "provider output\n{foo,bar}\n{/foo,bar}\n");

      app = await createTuiApp(context, fakeLogger([]), { input: ttyStream(), now: () => 1_000, output: ttyStream() });

      expect(() => app?.setStatus("ready")).not.toThrow();
    } finally {
      app?.stop();
      await removeDir(directory);
    }
  });

  test("honors stop requested before runner control is ready", async () => {
    const directory = await tempDir("roadrunner-tui-pending-stop-");
    let app: Awaited<ReturnType<typeof createTuiApp>> | null = null;
    let stopCalls = 0;
    try {
      const context = await createInitializedProject(directory);
      const input = ttyStream();
      app = await createTuiApp(context, fakeLogger([]), { input, now: () => 1_000, output: ttyStream() });

      input.write("q");
      input.emit("keypress", "q", { full: "q", name: "q" });
      await sleep(20);
      app.onControl({
        restartCurrentTask: () => false,
        stopRun: () => {
          stopCalls += 1;
          return true;
        },
      });
      await sleep(20);

      expect(stopCalls).toBe(1);
    } finally {
      app?.stop();
      await removeDir(directory);
    }
  });

  test("formats clean run state header and details", () => {
    const row = taskRow("current");
    const display: RunDisplayState = {
      attempt: null,
      lastActivityAt: 1_000,
      logPath: null,
      message: "Refreshing queue from roadmap and repository state.",
      pid: null,
      startedAt: 1_000,
      status: "REFRESHING QUEUE",
      stepId: "sample-step",
      title: "Ship Sample",
    };

    expect(headerText(display, 61_000)).toContain("REFRESHING QUEUE");
    expect(headerText(display, 61_000)).not.toContain("done");
    expect(detailsText(row, display, { blocked: 0, current: 1, done: 2, next: 3 }, 61_000, fakeLogger([]), "ACTIVE startup refresh · 00:00:01")).toContain(
      "Queue: 2 done · 1 active · 3 waiting · 0 blocked",
    );
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

    const display = displayStateFromProgress(progress, taskRow("current"));
    const blockedDisplay = { ...display, status: "FAILED" as const };
    const pidDisplay = { ...display, logPath: "/tmp/implement.log", pid: 123 };

    expect(headerText(display, 10_000)).toContain("IMPLEMENTING");
    expect(headerText(display, 10_000)).toContain("attempt 2");
    expect(headerText(pidDisplay, 70_000)).toContain("pid 123");
    expect(detailsText(null, display, { blocked: 0, current: 0, done: 0, next: 0 }, 70_000, fakeLogger([]), null)).toContain("State: IMPLEMENTING");
    expect(detailsText(taskRow("current"), pidDisplay, { blocked: 0, current: 1, done: 0, next: 0 }, 10_000, fakeLogger([]), "ACTIVE implement · 00:00:01")).toContain(
      "PID: 123",
    );
    expect(headerText({ ...display, status: "DONE" }, 70_000)).toContain("DONE");
    expect(detailsText(taskRow("current"), display, { blocked: 0, current: 1, done: 0, next: 0 }, 70_000, fakeLogger([]), null)).toContain("possibly stalled");
    expect(detailsText(blockedRow, blockedDisplay, { blocked: 1, current: 0, done: 0, next: 0 }, 70_000, fakeLogger([]), null)).toContain("Blocked: needs attention");
    expect(actionText(progress, false, false)).toContain("Restart Task");
    expect(actionText(null, true, false)).toContain("Restart current task? y/N");
    expect(actionText(null, false, true)).toContain("Stopping run and cleaning");
    expect(actionText(null, false, false)).toContain("Restart unavailable");
    expect(actionText(null, false, false)).toContain("Tab/Shift+Tab");

    expect(headerText(displayStateFromProgress({ ...progress, phase: "plan" }, taskRow("current")), 10_000)).toContain("PLANNING");
    expect(headerText(displayStateFromProgress({ ...progress, phase: "verify" }, taskRow("current")), 10_000)).toContain("VERIFYING");
    expect(headerText(displayStateFromProgress({ ...progress, phase: "verify-fixed" }, taskRow("current")), 10_000)).toContain("VERIFYING");
    expect(headerText(displayStateFromProgress({ ...progress, phase: "fix" }, taskRow("current")), 10_000)).toContain("FIXING");
    expect(headerText(displayStateFromProgress({ ...progress, phase: "reconcile" }, taskRow("current")), 10_000)).toContain("RECONCILING");
    expect(headerText(displayStateFromProgress({ ...progress, phase: "startup-refresh", stepId: null }, null), 10_000)).toContain("REFRESHING QUEUE");
    expect(headerText(displayStateFromProgress({ ...progress, phase: "startup-refresh", stepId: null }, taskRow("current")), 10_000)).toContain("sample-step");
  });

  test("cycles focus forward and backward", () => {
    expect(nextFocus("tasks")).toBe("logs");
    expect(nextFocus("logs")).toBe("log");
    expect(nextFocus("log")).toBe("tasks");
    expect(previousFocus("tasks")).toBe("log");
    expect(previousFocus("log")).toBe("logs");
    expect(previousFocus("logs")).toBe("tasks");
  });

  test("formats TUI session event messages and payloads", () => {
    expect(eventMessage({ command: ["opencode"], debug: false, logPath: "/tmp/plan.log", pid: 123, processTreeRoot: null, role: "plan", type: "provider-start" })).toBe(
      "provider started role=plan pid=123 log=/tmp/plan.log",
    );
    expect(eventMessage({ command: ["opencode"], debug: false, logPath: "/tmp/plan.log", pid: null, processTreeRoot: null, role: "plan", type: "provider-start" })).toBe(
      "provider started role=plan pid=n/a log=/tmp/plan.log",
    );
    expect(eventMessage({ step, type: "step" })).toBe("step sample-step");
    expect(eventPayload({ step, type: "step" })).toEqual({ stepId: "sample-step" });
    expect(eventMessage({ type: "cleanup" })).toBe("cleanup");
    expect(eventPayload({ type: "cleanup" })).toEqual({});
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
            showFailure: () => {},
            stop: () => {},
            waitForAction: async () => ({ type: "exit" as const }),
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
            showFailure: (failure) => statuses.push(failure.message),
            stop: () => {},
            waitForAction: async () => ({ type: "exit" as const }),
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

      expect(statuses).toEqual(["boom"]);
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
