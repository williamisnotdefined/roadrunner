import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import { run as runRoadrunner, type RoadrunnerRunEvent } from "../src/application/runner.js";
import { commitAll, removeDir, run } from "./helpers.js";
import { latestQueueSnapshot, logDirFor, setupRunnerProject, twoStepRoadmap } from "./runner-helpers.js";

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
});

describe("runner reconciliation", () => {
  test("does not fingerprint files during reconciliation", async () => {
    const project = await setupRunnerProject("reconcile-extra");
    const events: RoadrunnerRunEvent[] = [];
    try {
      expect(await runRoadrunner(project.context, { onEvent: (event) => events.push(event) })).toBe(1);
      expect(await readFile(path.join(project.directory, "unexpected.txt"), "utf8")).toBe("nope\n");
      const queue = latestQueueSnapshot(events);
      expect(queue.history[0]).toMatchObject({ id: "first-step" });
      expect(queue.blocked).toEqual([]);
    } finally {
      await removeDir(project.directory);
    }
  });

  test("does not treat reconciliation commits as queue-control state", async () => {
    const project = await setupRunnerProject("reconcile-commit-bypass");
    const events: RoadrunnerRunEvent[] = [];
    try {
      expect(await runRoadrunner(project.context, { onEvent: (event) => events.push(event) })).toBe(1);
      expect((await run("git", ["log", "--oneline", "--grep", "Agent reconcile commit"], project.directory)).stdout).toMatch(/Agent reconcile commit/);
      const queue = latestQueueSnapshot(events);
      expect(queue.history[0]).toMatchObject({ id: "first-step" });
      expect(queue.blocked).toEqual([]);
    } finally {
      await removeDir(project.directory);
    }
  });

  test("does not inspect git-ignored files during reconciliation", async () => {
    const project = await setupRunnerProject("reconcile-ignored-dirty");
    const events: RoadrunnerRunEvent[] = [];
    try {
      await writeFile(path.join(project.directory, ".gitignore"), ".env\n");
      await commitAll(project.directory, "Ignore local env files");

      expect(await runRoadrunner(project.context, { onEvent: (event) => events.push(event) })).toBe(1);
      expect(await readFile(path.join(project.directory, ".env"), "utf8")).toBe("SECRET=changed\n");
      const queue = latestQueueSnapshot(events);
      expect(queue.history[0]).toMatchObject({ id: "first-step", title: "Build first step" });
      expect(queue.blocked).toEqual([]);
    } finally {
      await removeDir(project.directory);
    }
  });

  test("accepts reconciliation changes to the next open queue item", async () => {
    const project = await setupRunnerProject("reconcile-queue", twoStepRoadmap());
    const events: RoadrunnerRunEvent[] = [];
    try {
      expect(await runRoadrunner(project.context, { onEvent: (event) => events.push(event) })).toBe(1);
      const queue = latestQueueSnapshot(events);

      expect(queue.history[0]).toMatchObject({ id: "first-step", title: "Build first step" });
      expect(queue.queue[0]).toMatchObject({ id: "second-step", title: "Reconciled first step" });
    } finally {
      await removeDir(project.directory);
    }
  });

  test("accepts reconciliation that removes obsolete open queue items", async () => {
    const project = await setupRunnerProject("reconcile-removes-current", twoStepRoadmap());
    const events: RoadrunnerRunEvent[] = [];
    try {
      expect(await runRoadrunner(project.context, { onEvent: (event) => events.push(event) })).toBe(1);
      const queue = latestQueueSnapshot(events);

      expect(queue.history[0]).toMatchObject({ id: "first-step", title: "Build first step" });
      expect(queue.queue).toEqual([]);
    } finally {
      await removeDir(project.directory);
    }
  });

  test("accepts reconciliation changes to future queue items", async () => {
    const project = await setupRunnerProject("reconcile-future-queue", twoStepRoadmap());
    const events: RoadrunnerRunEvent[] = [];
    try {
      expect(await runRoadrunner(project.context, { onEvent: (event) => events.push(event) })).toBe(1);
      const queue = latestQueueSnapshot(events);

      expect(queue.history[0]).toMatchObject({ id: "first-step", title: "Build first step" });
      expect(queue.queue[0]).toMatchObject({ id: "second-step", title: "Reconciled future step" });
    } finally {
      await removeDir(project.directory);
    }
  });

  test("appends the queue proposal contract to local reconciliation prompts", async () => {
    const project = await setupRunnerProject("success");
    try {
      await writeFile(
        path.join(project.context.paths.prompts, "reconcile-roadmap.md"),
        "# Roadrunner Reconciliation\n\n## Current Queue File\n\n```json\n{{QUEUE_JSON}}\n```\n",
      );

      expect(await runRoadrunner(project.context, { maxSteps: 1 })).toBe(1);
      const prompt = await readFile(path.join(await logDirFor(project.context, "first-step"), "reconcile.prompt.md"), "utf8");
      expect(prompt).toContain("Required Queue Proposal Output");
      expect(prompt).toContain("roadrunner-queue");
    } finally {
      await removeDir(project.directory);
    }
  });

  test("rejects reconciliation that rewrites closed queue records", async () => {
    const project = await setupRunnerProject("reconcile-closed");
    const events: RoadrunnerRunEvent[] = [];
    try {
      await expect(runRoadrunner(project.context, { onEvent: (event) => events.push(event) })).rejects.toThrow(/preserve history records/);
      const nextQueue = latestQueueSnapshot(events);
      expect(nextQueue.history.map((step) => step.id)).toEqual(["first-step"]);
      expect(nextQueue.blocked).toEqual([]);
    } finally {
      await removeDir(project.directory);
    }
  });

  test("preserves completed work when reconciliation provider fails after dirtying files", async () => {
    const project = await setupRunnerProject("reconcile-fail-dirty");
    const events: RoadrunnerRunEvent[] = [];
    try {
      await expect(runRoadrunner(project.context, { onEvent: (event) => events.push(event) })).rejects.toThrow(/Reconciliation failed/);
      expect(await readFile(path.join(project.directory, "unexpected.txt"), "utf8")).toBe("nope\n");
      const queue = latestQueueSnapshot(events);
      expect(queue.history[0]).toMatchObject({ id: "first-step" });
      expect(queue.blocked).toEqual([]);
    } finally {
      await removeDir(project.directory);
    }
  });

  test("preserves completed work when reconciliation provider fails", async () => {
    const project = await setupRunnerProject("reconcile-fail");
    const events: RoadrunnerRunEvent[] = [];
    try {
      await expect(runRoadrunner(project.context, { onEvent: (event) => events.push(event) })).rejects.toThrow(/Reconciliation failed/);
      const queue = latestQueueSnapshot(events);
      expect(queue.history.map((step) => step.id)).toEqual(["first-step"]);
      expect(queue.blocked).toEqual([]);
    } finally {
      await removeDir(project.directory);
    }
  });

  test("recovers queue state after invalid queue produced during reconciliation", async () => {
    const project = await setupRunnerProject("reconcile-invalid");
    const events: RoadrunnerRunEvent[] = [];
    try {
      await expect(runRoadrunner(project.context, { onEvent: (event) => events.push(event) })).rejects.toThrow(/queue.version must be 2/);
      const queue = latestQueueSnapshot(events);
      expect(queue.version).toBe(2);
      expect(queue.history[0]).toMatchObject({ id: "first-step" });
      expect(queue.blocked).toEqual([]);
    } finally {
      await removeDir(project.directory);
    }
  });
});
