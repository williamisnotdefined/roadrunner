import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import { readJson } from "../src/infrastructure/config.js";
import type { QueueFile } from "../src/domain/queue.js";
import { run as runRoadrunner } from "../src/application/runner.js";
import { removeDir } from "./helpers.js";
import { setupRunnerProject } from "./runner-helpers.js";

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
});

describe("runner startup refresh", () => {
  test("returns zero when startup refresh marks roadmap work already done", async () => {
    const project = await setupRunnerProject("startup-refresh-inferred-done");
    try {
      await rm(project.context.paths.queue, { force: true });

      expect(await runRoadrunner(project.context)).toBe(0);
      const queue = await readJson<QueueFile>(project.context.paths.queue);
      expect(queue.history.map((step) => step.id)).toEqual(["first-step"]);
      expect(queue.queue).toEqual([]);
    } finally {
      await removeDir(project.directory);
    }
  });

  test("hard-resets a missing queue from the roadmap at run start", async () => {
    const project = await setupRunnerProject("success");
    try {
      await rm(project.context.paths.queue, { force: true });

      expect(await runRoadrunner(project.context, { maxSteps: 1 })).toBe(1);
      const queue = await readJson<QueueFile>(project.context.paths.queue);
      expect(queue.history.map((step) => step.id)).toEqual(["first-step"]);
      expect(queue.blocked).toEqual([]);
    } finally {
      await removeDir(project.directory);
    }
  });

  test("compiles a strategic roadmap into an operational queue", async () => {
    const project = await setupRunnerProject("startup-refresh-from-strategic");
    try {
      await writeFile(project.context.paths.roadmap, `# Strategic Roadmap\n\nBuild the smallest useful marker-backed feature without operational fields.\n`);

      expect(await runRoadrunner(project.context, { maxSteps: 1 })).toBe(1);
      const queue = await readJson<QueueFile>(project.context.paths.queue);
      expect(queue.history.map((step) => step.id)).toEqual(["strategic-step"]);
    } finally {
      await removeDir(project.directory);
    }
  });

  test("rejects changes outside the queue and restores the seed queue", async () => {
    const project = await setupRunnerProject("startup-refresh-extra");
    try {
      await expect(runRoadrunner(project.context, { maxSteps: 1 })).rejects.toThrow(/Startup refresh may only update/);
      expect(await readFile(path.join(project.directory, "unexpected-startup.txt"), "utf8")).toBe("nope\n");
      const queue = await readJson<QueueFile>(project.context.paths.queue);
      expect(queue.queue.map((step) => step.id)).toEqual(["first-step"]);
      expect(queue.history).toEqual([]);
    } finally {
      await removeDir(project.directory);
    }
  });

  test("rejects invalid startup queues and restores the seed queue", async () => {
    const project = await setupRunnerProject("startup-refresh-invalid");
    try {
      await expect(runRoadrunner(project.context, { maxSteps: 1 })).rejects.toThrow(/queue.version must be 2/);
      const queue = await readJson<QueueFile>(project.context.paths.queue);
      expect(queue.version).toBe(2);
      expect(queue.queue.map((step) => step.id)).toEqual(["first-step"]);
    } finally {
      await removeDir(project.directory);
    }
  });

  test("fails when the startup refresh provider fails", async () => {
    const project = await setupRunnerProject("startup-refresh-fail");
    try {
      await expect(runRoadrunner(project.context, { maxSteps: 1 })).rejects.toThrow(/Startup refresh failed/);
      const queue = await readJson<QueueFile>(project.context.paths.queue);
      expect(queue.queue.map((step) => step.id)).toEqual(["first-step"]);
    } finally {
      await removeDir(project.directory);
    }
  });

  test("starts with an empty queue when no roadmap exists", async () => {
    const project = await setupRunnerProject("success");
    try {
      await rm(project.context.paths.roadmap, { force: true });
      await rm(project.context.paths.queue, { force: true });

      expect(await runRoadrunner(project.context, { maxSteps: 1 })).toBe(0);
      const queue = await readJson<QueueFile>(project.context.paths.queue);
      expect(queue.queue).toEqual([]);
      expect(queue.history).toEqual([]);
    } finally {
      await removeDir(project.directory);
    }
  });
});
