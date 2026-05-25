import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import { readJson } from "../src/config.js";
import type { QueueFile } from "../src/queue.js";
import { run as runRoadrunner } from "../src/runner.js";
import { commitAll, removeDir, run } from "./helpers.js";
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
      expect(queue.history[0]).toMatchObject({ id: "first-step" });
      expect(queue.blocked).toEqual([]);
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
      expect(queue.history[0]).toMatchObject({ id: "first-step" });
      expect(queue.blocked).toEqual([]);
    } finally {
      await removeDir(project.directory);
    }
  });

  test("rejects reconciliation changes to git-ignored files", async () => {
    const project = await setupRunnerProject("reconcile-ignored-dirty");
    try {
      await writeFile(path.join(project.directory, ".gitignore"), ".env\n");
      await commitAll(project.directory, "Ignore local env files");

      await expect(runRoadrunner(project.context)).rejects.toThrow(/only update the Roadrunner queue file/);
      expect(await readFile(path.join(project.directory, ".env"), "utf8")).toBe("SECRET=changed\n");
      const queue = await readJson<QueueFile>(project.context.paths.queue);
      expect(queue.history[0]).toMatchObject({ id: "first-step", title: "Build first step" });
      expect(queue.blocked).toEqual([]);
    } finally {
      await removeDir(project.directory);
    }
  });

  test("accepts reconciliation changes to the next open queue item", async () => {
    const project = await setupRunnerProject("reconcile-queue", twoStepRoadmap());
    try {
      expect(await runRoadrunner(project.context)).toBe(1);
      const queue = await readJson<QueueFile>(project.context.paths.queue);

      expect(queue.history[0]).toMatchObject({ id: "first-step", title: "Build first step" });
      expect(queue.queue[0]).toMatchObject({ id: "second-step", title: "Reconciled first step" });
    } finally {
      await removeDir(project.directory);
    }
  });

  test("accepts reconciliation that removes obsolete open queue items", async () => {
    const project = await setupRunnerProject("reconcile-removes-current", twoStepRoadmap());
    try {
      expect(await runRoadrunner(project.context)).toBe(1);
      const queue = await readJson<QueueFile>(project.context.paths.queue);

      expect(queue.history[0]).toMatchObject({ id: "first-step", title: "Build first step" });
      expect(queue.queue).toEqual([]);
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
      await expect(runRoadrunner(project.context)).rejects.toThrow(/preserve history records/);
      const nextQueue = await readJson<QueueFile>(project.context.paths.queue);
      expect(nextQueue.history.map((step) => step.id)).toEqual(["first-step"]);
      expect(nextQueue.blocked).toEqual([]);
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
      expect(queue.history[0]).toMatchObject({ id: "first-step" });
      expect(queue.blocked).toEqual([]);
    } finally {
      await removeDir(project.directory);
    }
  });

  test("preserves completed work when reconciliation provider fails", async () => {
    const project = await setupRunnerProject("reconcile-fail");
    try {
      await expect(runRoadrunner(project.context)).rejects.toThrow(/Reconciliation failed/);
      const queue = await readJson<QueueFile>(project.context.paths.queue);
      expect(queue.history.map((step) => step.id)).toEqual(["first-step"]);
      expect(queue.blocked).toEqual([]);
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
      expect(queue.history[0]).toMatchObject({ id: "first-step" });
      expect(queue.blocked).toEqual([]);
    } finally {
      await removeDir(project.directory);
    }
  });
});
