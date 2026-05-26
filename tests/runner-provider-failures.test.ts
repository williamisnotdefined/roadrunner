import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import { providerFor } from "../src/infrastructure/providers/index.js";
import { plan, run as runRoadrunner, type RoadrunnerRunEvent } from "../src/application/runner.js";
import { removeDir, run, sampleRoadmap } from "./helpers.js";
import { latestQueueSnapshot, logDirFor, setupRunnerProject } from "./runner-helpers.js";

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
});

describe("runner provider failures", () => {
  test("allows provider changes to GOALS.md", async () => {
    const project = await setupRunnerProject("goals-dirty");
    try {
      expect(await runRoadrunner(project.context)).toBe(1);
      expect(await readFile(path.join(project.directory, "GOALS.md"), "utf8")).toBe("changed\n");
    } finally {
      await removeDir(project.directory);
    }
  });

  test("allows provider commits", async () => {
    const project = await setupRunnerProject("git-commit");
    try {
      expect(await runRoadrunner(project.context)).toBe(1);
      expect((await run("git", ["log", "--oneline", "--grep", "Agent commit"], project.directory)).stdout).toMatch(/Agent commit/);
    } finally {
      await removeDir(project.directory);
    }
  });

  test("ignores stale queue files written by implementation agents", async () => {
    const project = await setupRunnerProject("queue-dirty");
    const events: RoadrunnerRunEvent[] = [];
    try {
      expect(await runRoadrunner(project.context, { onEvent: (event) => events.push(event) })).toBe(1);
      expect(latestQueueSnapshot(events).history.map((step) => step.id)).toEqual(["first-step"]);
    } finally {
      await removeDir(project.directory);
    }
  });

  test("ignores stale queue files written by verification commands", async () => {
    const verification = `node -e "const fs = require('node:fs'); fs.mkdirSync('.roadrunner/state', { recursive: true }); fs.writeFileSync('.roadrunner/state/queue.json', JSON.stringify({ stale: true }, null, 2) + '\\n');"`;
    const project = await setupRunnerProject("success", sampleRoadmap({ verification }));
    const events: RoadrunnerRunEvent[] = [];
    try {
      expect(await runRoadrunner(project.context, { onEvent: (event) => events.push(event) })).toBe(1);
      expect(latestQueueSnapshot(events).history.map((step) => step.id)).toEqual(["first-step"]);
    } finally {
      await removeDir(project.directory);
    }
  });

  test("ignores stale queue files written by fix agents", async () => {
    const project = await setupRunnerProject("fix-queue-dirty");
    const events: RoadrunnerRunEvent[] = [];
    try {
      expect(await runRoadrunner(project.context, { onEvent: (event) => events.push(event) })).toBe(1);
      expect(latestQueueSnapshot(events).history.map((step) => step.id)).toEqual(["first-step"]);
    } finally {
      await removeDir(project.directory);
    }
  });

  test("marks provider failures as blocked", async () => {
    const project = await setupRunnerProject("provider-fail");
    const events: RoadrunnerRunEvent[] = [];
    try {
      await expect(runRoadrunner(project.context, { onEvent: (event) => events.push(event) })).rejects.toThrow(/Implementation provider failed/);

      const queue = latestQueueSnapshot(events);
      expect(queue.queue).toEqual([]);
      expect(queue.blocked[0]).toMatchObject({ blockedReason: "Provider exited 7", id: "first-step" });
    } finally {
      await removeDir(project.directory);
    }
  });

  test("provider failures ignore stale runtime queue files", async () => {
    const project = await setupRunnerProject("provider-fail-queue-dirty");
    const events: RoadrunnerRunEvent[] = [];
    try {
      await expect(runRoadrunner(project.context, { onEvent: (event) => events.push(event) })).rejects.toThrow(/Implementation provider failed/);

      expect(latestQueueSnapshot(events).blocked[0]).toMatchObject({ blockedReason: "Provider exited 7", id: "first-step", title: "Build first step" });
    } finally {
      await removeDir(project.directory);
    }
  });

  test("provider failures ignore invalid stale runtime queue files", async () => {
    const project = await setupRunnerProject("provider-fail-invalid-queue");
    const events: RoadrunnerRunEvent[] = [];
    try {
      await expect(runRoadrunner(project.context, { onEvent: (event) => events.push(event) })).rejects.toThrow(/Implementation provider failed/);

      const queue = latestQueueSnapshot(events);
      expect(queue.version).toBe(2);
      expect(queue.blocked[0]).toMatchObject({ id: "first-step", title: "Build first step" });
      expect(queue.blocked[0]?.blockedReason).toBe("Provider exited 7");
    } finally {
      await removeDir(project.directory);
    }
  });

  test("provider failures ignore stale current-step files", async () => {
    const project = await setupRunnerProject("provider-fail-other-current");
    const events: RoadrunnerRunEvent[] = [];
    try {
      await expect(runRoadrunner(project.context, { onEvent: (event) => events.push(event) })).rejects.toThrow(/Implementation provider failed/);

      const queue = latestQueueSnapshot(events);
      expect(queue.blocked[0]).toMatchObject({ blockedReason: "Provider exited 7", id: "first-step" });
      expect(queue.queue).toEqual([]);
    } finally {
      await removeDir(project.directory);
    }
  });

  test("returns planning failures as blocked", async () => {
    const project = await setupRunnerProject("plan-fail");
    const events: RoadrunnerRunEvent[] = [];
    try {
      await expect(runRoadrunner(project.context, { onEvent: (event) => events.push(event) })).rejects.toThrow(/Planning provider failed/);
      const queue = latestQueueSnapshot(events);
      expect(queue.blocked[0]).toMatchObject({ blockedReason: "Planning exited 6", id: "first-step" });
    } finally {
      await removeDir(project.directory);
    }
  });

  test("fixes verification failures once and completes the step", async () => {
    const project = await setupRunnerProject("fix-success");
    try {
      expect(await runRoadrunner(project.context)).toBe(1);
      const stepLogDir = await logDirFor(project.context, "first-step");
      const planLogDir = await logDirFor(project.context, "first-step-plan");
      const implementPrompt = await readFile(path.join(stepLogDir, "implement.prompt.md"), "utf8");
      const fixPrompt = await readFile(path.join(stepLogDir, "fix-failure.prompt.md"), "utf8");

      expect(await readFile(path.join(project.directory, "marker.txt"), "utf8")).toBe("ok\n");
      expect(await readFile(path.join(planLogDir, "plan.clean.md"), "utf8")).toMatch(/Plan: implement the requested step/);
      expect(implementPrompt).toContain("Plan: implement the requested step.");
      expect(implementPrompt).not.toContain("planning trace that should stay out of implementation prompts");
      expect(fixPrompt).toContain("Plan: implement the requested step.");
      expect(fixPrompt).not.toContain("planning trace that should stay out of implementation prompts");
    } finally {
      await removeDir(project.directory);
    }
  });

  test("marks invalid planning output as blocked", async () => {
    const project = await setupRunnerProject("plan-missing-block");
    const events: RoadrunnerRunEvent[] = [];
    try {
      await expect(runRoadrunner(project.context, { onEvent: (event) => events.push(event) })).rejects.toThrow(/roadrunner-plan/);
      const queue = latestQueueSnapshot(events);
      expect(queue.blocked[0]).toMatchObject({ id: "first-step" });
      expect(queue.blocked[0]?.blockedReason).toMatch(/Planning output invalid/);
    } finally {
      await removeDir(project.directory);
    }
  });

  test("marks verification failures as blocked when fix fails", async () => {
    const project = await setupRunnerProject("fix-fail");
    const events: RoadrunnerRunEvent[] = [];
    try {
      await expect(runRoadrunner(project.context, { onEvent: (event) => events.push(event) })).rejects.toThrow(/Verification failed/);

      const queue = latestQueueSnapshot(events);
      expect(queue.blocked[0]).toMatchObject({ blockedReason: "Verification failed after fix attempt.", id: "first-step" });
    } finally {
      await removeDir(project.directory);
    }
  });

  test("rejects unsupported providers", async () => {
    const project = await setupRunnerProject("success");
    try {
      project.context.config.provider = "other";
      await expect(plan(project.context)).rejects.toThrow(/Unsupported provider/);
      expect(() => providerFor(project.context)).toThrow(/Unsupported provider/);
    } finally {
      await removeDir(project.directory);
    }
  });
});
