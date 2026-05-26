import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import { run as runRoadrunner, type RoadrunnerRunEvent } from "../src/application/runner.js";
import { removeDir } from "./helpers.js";
import { latestQueueSnapshot, setupRunnerProject } from "./runner-helpers.js";

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
});

describe("runner startup refresh", () => {
  test("returns zero when startup refresh marks roadmap work already done", async () => {
    const project = await setupRunnerProject("startup-refresh-inferred-done");
    const events: RoadrunnerRunEvent[] = [];
    try {
      await rm(project.context.paths.queue, { force: true });

      expect(await runRoadrunner(project.context, { onEvent: (event) => events.push(event) })).toBe(0);
      const queue = latestQueueSnapshot(events);
      expect(queue.history.map((step) => step.id)).toEqual(["first-step"]);
      expect(queue.queue).toEqual([]);
    } finally {
      await removeDir(project.directory);
    }
  });

  test("hard-resets a missing queue from the roadmap at run start", async () => {
    const project = await setupRunnerProject("success");
    const events: RoadrunnerRunEvent[] = [];
    try {
      await rm(project.context.paths.queue, { force: true });

      expect(await runRoadrunner(project.context, { maxSteps: 1, onEvent: (event) => events.push(event) })).toBe(1);
      const queue = latestQueueSnapshot(events);
      expect(queue.history.map((step) => step.id)).toEqual(["first-step"]);
      expect(queue.blocked).toEqual([]);
    } finally {
      await removeDir(project.directory);
    }
  });

  test("compiles a strategic roadmap into an operational queue", async () => {
    const project = await setupRunnerProject("startup-refresh-from-strategic");
    const events: RoadrunnerRunEvent[] = [];
    try {
      await writeFile(project.context.paths.roadmap, `# Strategic Roadmap\n\nBuild the smallest useful marker-backed feature without operational fields.\n`);

      expect(await runRoadrunner(project.context, { maxSteps: 1, onEvent: (event) => events.push(event) })).toBe(1);
      const queue = latestQueueSnapshot(events);
      expect(queue.history.map((step) => step.id)).toEqual(["strategic-step"]);
    } finally {
      await removeDir(project.directory);
    }
  });

  test("does not use git or file mutation fingerprints during startup refresh", async () => {
    const project = await setupRunnerProject("startup-refresh-extra");
    const events: RoadrunnerRunEvent[] = [];
    try {
      expect(await runRoadrunner(project.context, { maxSteps: 1, onEvent: (event) => events.push(event) })).toBe(1);
      expect(await readFile(path.join(project.directory, "unexpected-startup.txt"), "utf8")).toBe("nope\n");
      expect(latestQueueSnapshot(events).history.map((step) => step.id)).toEqual(["first-step"]);
    } finally {
      await removeDir(project.directory);
    }
  });

  test("rejects invalid startup queue proposals", async () => {
    const project = await setupRunnerProject("startup-refresh-invalid");
    try {
      await expect(runRoadrunner(project.context, { maxSteps: 1 })).rejects.toThrow(/queue.version must be 2/);
    } finally {
      await removeDir(project.directory);
    }
  });

  test("fails when the startup refresh provider fails", async () => {
    const project = await setupRunnerProject("startup-refresh-fail");
    try {
      await expect(runRoadrunner(project.context, { maxSteps: 1 })).rejects.toThrow(/Startup refresh failed/);
    } finally {
      await removeDir(project.directory);
    }
  });

  test("starts with an empty queue when no roadmap exists", async () => {
    const project = await setupRunnerProject("success");
    const events: RoadrunnerRunEvent[] = [];
    try {
      await rm(project.context.paths.roadmap, { force: true });
      await rm(project.context.paths.queue, { force: true });

      expect(await runRoadrunner(project.context, { maxSteps: 1, onEvent: (event) => events.push(event) })).toBe(0);
      const queue = latestQueueSnapshot(events);
      expect(queue.queue).toEqual([]);
      expect(queue.history).toEqual([]);
    } finally {
      await removeDir(project.directory);
    }
  });
});
