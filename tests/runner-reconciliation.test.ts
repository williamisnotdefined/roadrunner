import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import { readJson, writeJson } from "../src/config.js";
import type { QueueFile } from "../src/queue.js";
import { run as runRoadrunner } from "../src/runner.js";
import { removeDir, run } from "./helpers.js";
import { setupRunnerProject, twoStepRoadmap } from "./runner-helpers.js";

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
});

describe("runner reconciliation", () => {
  test("rejects reconciliation changes outside the queue", async () => {
    const project = await setupRunnerProject("reconcile-extra");
    try {
      await expect(runRoadrunner(project.context)).rejects.toThrow(/only update the Roadrunner queue file/);
      expect(await readFile(path.join(project.directory, "unexpected.txt"), "utf8")).toBe("nope\n");
      const queue = await readJson<QueueFile>(project.context.paths.queue);
      expect(queue.blocked[0]).toMatchObject({ id: "first-step" });
    } finally {
      await removeDir(project.directory);
    }
  });

  test("rejects reconciliation commits outside Roadrunner", async () => {
    const project = await setupRunnerProject("reconcile-commit-bypass");
    try {
      await expect(runRoadrunner(project.context)).rejects.toThrow(/only update the Roadrunner queue file/);
      expect((await run("git", ["log", "--oneline", "--grep", "Agent reconcile commit"], project.directory)).stdout).toMatch(/Agent reconcile commit/);
      const queue = await readJson<QueueFile>(project.context.paths.queue);
      expect(queue.blocked[0]).toMatchObject({ id: "first-step" });
    } finally {
      await removeDir(project.directory);
    }
  });

  test("rejects reconciliation that edits the current step", async () => {
    const project = await setupRunnerProject("reconcile-queue");
    try {
      await expect(runRoadrunner(project.context)).rejects.toThrow(/preserve queue\[0\]/);
      const queue = await readJson<QueueFile>(project.context.paths.queue);

      expect(queue.blocked[0]).toMatchObject({ id: "first-step", title: "Build first step" });
    } finally {
      await removeDir(project.directory);
    }
  });

  test("rejects reconciliation that removes the current step", async () => {
    const project = await setupRunnerProject("reconcile-removes-current");
    try {
      await expect(runRoadrunner(project.context)).rejects.toThrow(/preserve queue\[0\]/);
      const queue = await readJson<QueueFile>(project.context.paths.queue);

      expect(queue.blocked[0]).toMatchObject({ id: "first-step", title: "Build first step" });
    } finally {
      await removeDir(project.directory);
    }
  });

  test("accepts reconciliation changes to future queue items", async () => {
    const project = await setupRunnerProject("reconcile-future-queue", twoStepRoadmap());
    try {
      expect(await runRoadrunner(project.context)).toBe(1);
      const queue = await readJson<QueueFile>(project.context.paths.queue);

      expect(queue.history[0]).toMatchObject({ id: "first-step", title: "Build first step" });
      expect(queue.queue[0]).toMatchObject({ id: "second-step", title: "Reconciled future step" });
    } finally {
      await removeDir(project.directory);
    }
  });

  test("rejects reconciliation that rewrites closed queue records", async () => {
    const project = await setupRunnerProject("reconcile-closed");
    try {
      const queue = await readJson<QueueFile>(project.context.paths.queue);
      queue.history.push({ ...queue.queue[0]!, id: "completed-step", title: "Completed step" });
      queue.blocked.push({ ...queue.queue[0]!, id: "blocked-step", title: "Blocked step" });
      await writeJson(project.context.paths.queue, queue);

      await expect(runRoadrunner(project.context)).rejects.toThrow(/preserve history records/);
      const nextQueue = await readJson<QueueFile>(project.context.paths.queue);
      expect(nextQueue.history.map((step) => step.id)).toEqual(["completed-step"]);
      expect(nextQueue.blocked.map((step) => step.id)).toEqual(["blocked-step", "first-step"]);
    } finally {
      await removeDir(project.directory);
    }
  });

  test("marks failed reconciliation provider runs as blocked without cleaning files", async () => {
    const project = await setupRunnerProject("reconcile-fail-dirty");
    try {
      await expect(runRoadrunner(project.context)).rejects.toThrow(/only update the Roadrunner queue file/);
      expect(await readFile(path.join(project.directory, "unexpected.txt"), "utf8")).toBe("nope\n");
      const queue = await readJson<QueueFile>(project.context.paths.queue);
      expect(queue.blocked[0]).toMatchObject({ id: "first-step" });
    } finally {
      await removeDir(project.directory);
    }
  });

  test("recovers queue state after invalid queue produced during reconciliation", async () => {
    const project = await setupRunnerProject("reconcile-invalid");
    try {
      await expect(runRoadrunner(project.context)).rejects.toThrow(/queue.version must be 2/);
      const queue = await readJson<QueueFile>(project.context.paths.queue);
      expect(queue.version).toBe(2);
      expect(queue.blocked[0]).toMatchObject({ id: "first-step" });
    } finally {
      await removeDir(project.directory);
    }
  });
});
