import { describe, expect, test } from "vitest";
import { PassThrough } from "node:stream";

import { loadContext } from "../src/config.js";
import { runWithTui } from "../src/run-tui.js";
import type { RoadrunnerRunControl, RunOptions } from "../src/runner.js";
import { removeDir, tempDir } from "./helpers.js";

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
};

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

function ttyStream(): PassThrough & { isTTY: boolean } {
  const stream = new PassThrough() as PassThrough & { isTTY: boolean };
  stream.isTTY = true;
  return stream;
}
