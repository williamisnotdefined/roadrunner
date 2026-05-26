import { afterEach, describe, expect, test } from "vitest";

import type { QueueStep } from "../src/domain/queue.js";
import { createRunControl, type CurrentAttemptState, type RunControlState } from "../src/application/runner-control.js";
import { run as runRoadrunner, type RoadrunnerRunControl, type RoadrunnerRunEvent } from "../src/application/runner.js";
import { removeDir } from "./helpers.js";
import { latestQueueSnapshot, setupRunnerProject } from "./runner-helpers.js";

const sampleStep: QueueStep = {
  acceptance: ["works"],
  id: "sample-step",
  phase: "Sample",
  prompt: "Build it.",
  scope: ["src/sample.ts"],
  title: "Ship Sample",
  verification: ["npm test"],
};

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
});

describe("runner restart control", () => {
  test("reports unavailable and duplicate restart requests", () => {
    const events: RoadrunnerRunEvent[] = [];
    const state: RunControlState = { activeAbortController: null, current: null, stopRequested: false };
    const control = createRunControl(state, (event) => events.push(event));

    expect(control.restartCurrentTask()).toBe(false);

    const abortController = new AbortController();
    const current: CurrentAttemptState = {
      abortController,
      lastActivityAt: Date.now() - 1000,
      phase: "implement",
      restartReason: null,
      restartRequested: false,
      startedAt: Date.now() - 1000,
      step: sampleStep,
    };
    state.current = current;

    expect(control.restartCurrentTask()).toBe(true);
    expect(control.restartCurrentTask()).toBe(true);
    expect(abortController.signal.aborted).toBe(true);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ phase: "implement", step: sampleStep, type: "task-restart-requested" });
  });

  test("stop control aborts active work and prevents restarts", () => {
    const events: RoadrunnerRunEvent[] = [];
    const state: RunControlState = { activeAbortController: new AbortController(), current: null, stopRequested: false };
    const control = createRunControl(state, (event) => events.push(event));
    const abortController = new AbortController();
    state.current = {
      abortController,
      lastActivityAt: Date.now() - 1000,
      phase: "implement",
      restartReason: null,
      restartRequested: false,
      startedAt: Date.now() - 1000,
      step: sampleStep,
    };

    expect(control.stopRun()).toBe(true);
    expect(control.stopRun()).toBe(true);
    expect(control.restartCurrentTask()).toBe(false);
    expect(state.stopRequested).toBe(true);
    expect(abortController.signal.aborted).toBe(true);
    expect(state.activeAbortController?.signal.aborted).toBe(true);
    expect(events).toEqual([{ type: "run-stop-requested" }]);
  });

  test("stops the current task without blocking it", async () => {
    const project = await setupRunnerProject("hang-once-plan");
    const events: string[] = [];
    const runEvents: RoadrunnerRunEvent[] = [];
    let control: RoadrunnerRunControl | null = null;
    process.env.ROADRUNNER_PROVIDER_TIMEOUT_MS = "0";

    try {
      const completed = await runRoadrunner(project.context, {
        maxSteps: 1,
        onControl: (nextControl) => {
          control = nextControl;
        },
        onEvent: (event) => {
          runEvents.push(event);
          events.push(event.type);
          if (event.type === "provider-start" && event.role === "plan") control?.stopRun();
        },
      });
      const queue = latestQueueSnapshot(runEvents);

      expect(completed).toBe(0);
      expect(events).toContain("run-stop-requested");
      expect(events).toContain("cleanup");
      expect(queue.history).toEqual([]);
      expect(queue.blocked).toEqual([]);
      expect(queue.queue[0]?.id).toBe("first-step");
    } finally {
      await removeDir(project.directory);
    }
  });

  test("stops startup refresh through run control", async () => {
    const project = await setupRunnerProject("success");
    const events: string[] = [];

    try {
      const completed = await runRoadrunner(project.context, {
        maxSteps: 1,
        onControl: (nextControl) => {
          nextControl.stopRun();
        },
        onEvent: (event) => {
          events.push(event.type);
        },
      });

      expect(completed).toBe(0);
      expect(events).toContain("run-stop-requested");
      expect(events).toContain("cleanup");
    } finally {
      await removeDir(project.directory);
    }
  });

  test("stops post-step reconciliation without blocking the completed step", async () => {
    const project = await setupRunnerProject("success");
    const events: string[] = [];
    const runEvents: RoadrunnerRunEvent[] = [];
    let control: RoadrunnerRunControl | null = null;

    try {
      const completed = await runRoadrunner(project.context, {
        maxSteps: 1,
        onControl: (nextControl) => {
          control = nextControl;
        },
        onEvent: (event) => {
          runEvents.push(event);
          events.push(event.type);
          if (event.type === "provider-start" && event.role === "reconcile") control?.stopRun();
        },
      });
      const queue = latestQueueSnapshot(runEvents);

      expect(completed).toBe(1);
      expect(events).toContain("run-stop-requested");
      expect(events).toContain("cleanup");
      expect(queue.history.map((step) => step.id)).toEqual(["first-step"]);
      expect(queue.blocked).toEqual([]);
    } finally {
      await removeDir(project.directory);
    }
  });

  test("does not restart a completed task during post-step reconciliation", async () => {
    const project = await setupRunnerProject("success");
    const events: string[] = [];
    const runEvents: RoadrunnerRunEvent[] = [];
    let control: RoadrunnerRunControl | null = null;
    let restartRequested = false;

    try {
      const completed = await runRoadrunner(project.context, {
        maxHours: 1,
        maxSteps: 1,
        onControl: (nextControl) => {
          control = nextControl;
        },
        onEvent: (event) => {
          runEvents.push(event);
          events.push(event.type);
          if (event.type === "provider-start" && event.role === "reconcile" && !restartRequested) {
            restartRequested = true;
            if (control?.restartCurrentTask() !== false) throw new Error("Expected completed task restart to be unavailable.");
          }
        },
      });
      const queue = latestQueueSnapshot(runEvents);

      expect(completed).toBe(1);
      expect(restartRequested).toBe(true);
      expect(events).not.toContain("task-restart-requested");
      expect(events).not.toContain("task-restart");
      expect(queue.history.map((step) => step.id)).toEqual(["first-step"]);
      expect(queue.blocked).toEqual([]);
    } finally {
      await removeDir(project.directory);
    }
  });

  test("automatically restarts idle provider attempts", async () => {
    const project = await setupRunnerProject("hang-once-plan");
    const events: RoadrunnerRunEvent[] = [];
    process.env.ROADRUNNER_AUTO_RESTART_IDLE_MS = "500";
    process.env.ROADRUNNER_MAX_AUTO_RESTARTS_PER_STEP = "2";

    try {
      const completed = await runRoadrunner(project.context, { maxSteps: 1, onEvent: (event) => events.push(event) });
      const queue = latestQueueSnapshot(events);

      expect(completed).toBe(1);
      expect(events).toContainEqual(expect.objectContaining({ restart: 1, step: expect.objectContaining({ id: "first-step" }), type: "task-auto-restart-requested" }));
      expect(events).toContainEqual(expect.objectContaining({ attempt: 2, step: expect.objectContaining({ id: "first-step" }), type: "task-restart" }));
      expect(queue.history.map((step) => step.id)).toEqual(["first-step"]);
      expect(queue.blocked).toEqual([]);
    } finally {
      await removeDir(project.directory);
    }
  });

  test("retries from in-memory queue after stale runtime queue writes", async () => {
    const project = await setupRunnerProject("queue-dirty-hang");
    const events: RoadrunnerRunEvent[] = [];
    process.env.ROADRUNNER_AUTO_RESTART_IDLE_MS = "500";
    process.env.ROADRUNNER_MAX_AUTO_RESTARTS_PER_STEP = "2";
    process.env.ROADRUNNER_PROVIDER_TIMEOUT_MS = "0";

    try {
      await expect(runRoadrunner(project.context, { maxSteps: 1, onEvent: (event) => events.push(event) })).rejects.toThrow(/Automatic restart limit exceeded/);
      const queue = latestQueueSnapshot(events);

      expect(queue.blocked[0]).toMatchObject({ id: "first-step", title: "Build first step" });
    } finally {
      await removeDir(project.directory);
    }
  });

  test("blocks a step after automatic restart limit is exceeded", async () => {
    const project = await setupRunnerProject("hang");
    const events: RoadrunnerRunEvent[] = [];
    process.env.ROADRUNNER_AUTO_RESTART_IDLE_MS = "500";
    process.env.ROADRUNNER_MAX_AUTO_RESTARTS_PER_STEP = "1";
    process.env.ROADRUNNER_PROVIDER_TIMEOUT_MS = "0";

    try {
      await expect(runRoadrunner(project.context, { maxSteps: 1, onEvent: (event) => events.push(event) })).rejects.toThrow(/Automatic restart limit exceeded/);
      const queue = latestQueueSnapshot(events);

      expect(events).toContainEqual(expect.objectContaining({ restart: 1, type: "task-auto-restart-requested" }));
      expect(events).toContainEqual(expect.objectContaining({ maxRestarts: 1, type: "task-auto-restart-limit-exceeded" }));
      expect(queue.blocked[0]).toMatchObject({ blockedReason: "Provider idle for 0s after 1 automatic restarts.", id: "first-step" });
    } finally {
      await removeDir(project.directory);
    }
  });

  test("does not restart providers that keep producing output", async () => {
    const project = await setupRunnerProject("slow-plan-success");
    const events: RoadrunnerRunEvent[] = [];
    process.env.ROADRUNNER_AUTO_RESTART_IDLE_MS = "500";

    try {
      expect(await runRoadrunner(project.context, { maxSteps: 1, onEvent: (event) => events.push(event) })).toBe(1);

      expect(events.some((event) => event.type === "task-auto-restart-requested")).toBe(false);
    } finally {
      await removeDir(project.directory);
    }
  });
});
