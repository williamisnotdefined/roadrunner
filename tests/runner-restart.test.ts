import { describe, expect, test } from "vitest";

import { readJson } from "../src/config.js";
import type { QueueFile, QueueStep } from "../src/queue.js";
import { run as runRoadrunner, type RoadrunnerRunControl, type RoadrunnerRunEvent } from "../src/runner.js";
import { createRunControl, type CurrentAttemptState, type RunControlState } from "../src/runner-execution.js";
import { removeDir } from "./helpers.js";
import { setupRunnerProject } from "./runner-helpers.js";

const sampleStep: QueueStep = {
  acceptance: ["works"],
  id: "sample-step",
  phase: "Sample",
  prompt: "Build it.",
  scope: ["src/sample.ts"],
  title: "Ship Sample",
  verification: ["npm test"],
};

describe("runner restart control", () => {
  test("reports unavailable and duplicate restart requests", () => {
    const events: RoadrunnerRunEvent[] = [];
    const state: RunControlState = { current: null };
    const control = createRunControl(state, (event) => events.push(event));

    expect(control.restartCurrentTask()).toBe(false);

    const abortController = new AbortController();
    const current: CurrentAttemptState = {
      abortController,
      phase: "implement",
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

  test("restarts instead of blocking when requested during reconciliation", async () => {
    const project = await setupRunnerProject("success");
    const events: string[] = [];
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
          events.push(event.type);
          if (event.type === "provider-start" && event.role === "reconcile" && !restartRequested) {
            restartRequested = true;
            if (!control?.restartCurrentTask()) throw new Error("Expected active task restart control.");
          }
        },
      });
      const queue = await readJson<QueueFile>(project.context.paths.queue);

      expect(completed).toBe(1);
      expect(restartRequested).toBe(true);
      expect(events).toContain("task-restart-requested");
      expect(events).toContain("task-restart");
      expect(queue.history.map((step) => step.id)).toEqual(["first-step"]);
      expect(queue.blocked).toEqual([]);
    } finally {
      await removeDir(project.directory);
    }
  });
});
