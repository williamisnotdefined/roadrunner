import { describe, expect, test } from "vitest";
import { PassThrough } from "node:stream";

import { AutomaticRestartLimitExceededError } from "../src/application/run-errors.js";
import { loadContext, writeJson } from "../src/infrastructure/config.js";
import { queueFileFromRoadmap } from "../src/domain/roadmap.js";
import type { RunTuiAction } from "../src/ui/run-tui-actions.js";
import { runWithTui } from "../src/ui/run-tui.js";
import { sampleRoadmap, removeDir, tempDir } from "./helpers.js";
import { setupRunnerProject } from "./runner-helpers.js";

describe("run TUI directives", () => {
  test("captures an operator directive and passes it to later runs", async () => {
    const directory = await tempDir("roadrunner-tui-directive-");
    const seenDirectives: (string | null | undefined)[] = [];
    const actions: RunTuiAction[] = [{ text: "prioritize fixtures before depth expansion", type: "add-directive" }, { type: "play" }, { type: "exit" }];
    try {
      const context = await loadContext(directory, { _: [] });
      await runWithTui(context, {
        appFactory: async () => ({
          onActivity: () => {},
          onControl: () => {},
          onEvent: () => {},
          setStatus: () => {},
          showFailure: () => {},
          stop: () => {},
          waitForAction: async () => actions.shift() ?? { type: "exit" as const },
        }),
        input: new PassThrough(),
        isInteractive: true,
        output: new PassThrough(),
        runner: async (_context, options) => {
          seenDirectives.push(options.operatorDirective);
          return 0;
        },
        settleMs: 0,
      });

      expect(seenDirectives).toEqual([null, "prioritize fixtures before depth expansion"]);
    } finally {
      await removeDir(directory);
    }
  });

  test("handles idle cockpit actions before exit", async () => {
    const directory = await tempDir("roadrunner-tui-actions-");
    const statuses: string[] = [];
    const actions: RunTuiAction[] = [{ type: "cleanup" }, { type: "reconcile" }, { type: "pause" }, { type: "view-logs" }, { type: "exit" }];
    try {
      const context = await loadContext(directory, { _: [] });
      await runWithTui(context, {
        appFactory: async () => fakeApp(actions, statuses),
        input: new PassThrough(),
        isInteractive: true,
        output: new PassThrough(),
        runner: async () => 0,
        settleMs: 0,
      });

      expect(statuses).toContain("No Roadrunner-owned processes are registered.");
      expect(statuses).toContain("No queue is loaded yet. Press p/Space to start or load Roadrunner state first.");
      expect(statuses).toContain("Paused. Press p/Space to play or q to exit.");
      expect(statuses).toContain("Viewing logs. Press r to restart, p/Space to play, or q to exit.");
    } finally {
      await removeDir(directory);
    }
  });

  test("keeps auto-restart failures recoverable in the cockpit", async () => {
    const directory = await tempDir("roadrunner-tui-auto-limit-");
    const failures: string[] = [];
    const step = queueFileFromRoadmap(sampleRoadmap(), { model: "openai/gpt-5.5", variant: "xhigh" }).queue[0]!;
    try {
      const context = await loadContext(directory, { _: [] });
      await expect(
        runWithTui(context, {
          appFactory: async () => ({ ...fakeApp([{ type: "exit" as const }], []), showFailure: (failure) => failures.push(failure.title) }),
          input: new PassThrough(),
          isInteractive: true,
          output: new PassThrough(),
          runner: async () => {
            throw new AutomaticRestartLimitExceededError({ idleMs: 1000, maxRestarts: 10, phase: null, policy: { enabled: true, idleMs: 1000, maxRestarts: 10 }, step });
          },
          settleMs: 0,
        }),
      ).rejects.toThrow(/Automatic restart limit exceeded/);

      expect(failures).toEqual(["Auto-restart limit exceeded"]);
    } finally {
      await removeDir(directory);
    }
  });

  test("restarts a failed run from the cockpit", async () => {
    const directory = await tempDir("roadrunner-tui-restart-");
    const statuses: string[] = [];
    const actions: RunTuiAction[] = [{ type: "restart-task" }, { type: "exit" }];
    let calls = 0;
    try {
      const context = await loadContext(directory, { _: [] });
      const completed = await runWithTui(context, {
        appFactory: async () => fakeApp(actions, statuses),
        input: new PassThrough(),
        isInteractive: true,
        output: new PassThrough(),
        runner: async () => {
          calls += 1;
          if (calls === 1) throw new Error("boom");
          return 3;
        },
        settleMs: 0,
      });

      expect(completed).toBe(3);
      expect(statuses).toContain("Restarting task from planning.");
    } finally {
      await removeDir(directory);
    }
  });

  test("reports cleanup work when registered process records exist", async () => {
    const directory = await tempDir("roadrunner-tui-cleanup-");
    const statuses: string[] = [];
    const actions: RunTuiAction[] = [{ type: "cleanup" }, { type: "exit" }];
    try {
      const context = await loadContext(directory, { _: [] });
      await writeJson(context.paths.processRegistry, { processes: [{ command: ["opencode"], cwd: "/outside", pid: 1, processGroupId: 1, role: "provider" }] });
      await runWithTui(context, {
        appFactory: async () => fakeApp(actions, statuses),
        input: new PassThrough(),
        isInteractive: true,
        output: new PassThrough(),
        runner: async () => 0,
        settleMs: 0,
      });

      expect(statuses).toContain("Cleaned 1 Roadrunner-owned process record(s).");
    } finally {
      await removeDir(directory);
    }
  });

  test("runs global reconcile from a loaded queue", async () => {
    const project = await setupRunnerProject("reconcile-queue");
    const statuses: string[] = [];
    const actions: RunTuiAction[] = [{ type: "reconcile" }, { type: "exit" }];
    try {
      const queueFile = queueFileFromRoadmap(sampleRoadmap(), project.context.config);
      await runWithTui(project.context, {
        appFactory: async () => fakeApp(actions, statuses),
        input: new PassThrough(),
        isInteractive: true,
        output: new PassThrough(),
        runner: async (_context, options) => {
          options.onEvent?.({ queueFile, type: "queue-updated" });
          return 0;
        },
        settleMs: 0,
      });

      expect(statuses.some((status) => status.startsWith("Reconciled queue. Log:"))).toBe(true);
    } finally {
      await removeDir(project.directory);
    }
  });

  test("reports global reconcile failures without exiting the cockpit", async () => {
    const project = await setupRunnerProject("reconcile-invalid");
    const failures: string[] = [];
    const actions: RunTuiAction[] = [{ type: "reconcile" }, { type: "exit" }];
    try {
      const queueFile = queueFileFromRoadmap(sampleRoadmap(), project.context.config);
      await runWithTui(project.context, {
        appFactory: async () => ({ ...fakeApp(actions, []), showFailure: (failure) => failures.push(failure.title) }),
        input: new PassThrough(),
        isInteractive: true,
        output: new PassThrough(),
        runner: async (_context, options) => {
          options.onEvent?.({ queueFile, type: "queue-updated" });
          return 0;
        },
        settleMs: 0,
      });

      expect(failures).toEqual(["Global reconcile failed"]);
    } finally {
      await removeDir(project.directory);
    }
  });
});

function fakeApp(actions: RunTuiAction[], statuses: string[]) {
  return {
    onActivity: () => {},
    onControl: () => {},
    onEvent: () => {},
    setStatus: (status: string) => {
      statuses.push(status);
    },
    showFailure: (failure: { message: string }) => {
      statuses.push(failure.message);
    },
    stop: () => {},
    waitForAction: async () => actions.shift() ?? { type: "exit" as const },
  };
}
