import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import { readJson } from "../src/config.js";
import type { QueueFile } from "../src/queue.js";
import { providerFor } from "../src/providers/index.js";
import { plan, run as runRoadrunner } from "../src/runner.js";
import { removeDir, run, sampleRoadmap } from "./helpers.js";
import { setupRunnerProject } from "./runner-helpers.js";

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

  test("blocks implementation agents that mutate queue state", async () => {
    const project = await setupRunnerProject("queue-dirty");
    try {
      await expect(runRoadrunner(project.context)).rejects.toThrow(/Implementation may not update/);
      const queue = await readJson<QueueFile>(project.context.paths.queue);
      expect(queue.blocked[0]).toMatchObject({ blockedReason: "Implementation may not update the Roadrunner queue file.", id: "first-step", title: "Build first step" });
    } finally {
      await removeDir(project.directory);
    }
  });

  test("blocks verification commands that mutate queue state", async () => {
    const verification = `node -e "const fs = require('node:fs'); const q = JSON.parse(fs.readFileSync('.roadrunner/queue.json', 'utf8')); q.queue[0].title = 'Verification touched queue'; fs.writeFileSync('.roadrunner/queue.json', JSON.stringify(q, null, 2) + '\\n');"`;
    const project = await setupRunnerProject("success", sampleRoadmap({ verification }));
    try {
      await expect(runRoadrunner(project.context)).rejects.toThrow(/Verification may not update/);
      const queue = await readJson<QueueFile>(project.context.paths.queue);
      expect(queue.blocked[0]).toMatchObject({ blockedReason: "Verification may not update the Roadrunner queue file.", id: "first-step", title: "Build first step" });
    } finally {
      await removeDir(project.directory);
    }
  });

  test("blocks fix agents that mutate queue state", async () => {
    const project = await setupRunnerProject("fix-queue-dirty");
    try {
      await expect(runRoadrunner(project.context)).rejects.toThrow(/Fix attempts may not update/);
      const queue = await readJson<QueueFile>(project.context.paths.queue);
      expect(queue.blocked[0]).toMatchObject({ blockedReason: "Fix attempts may not update the Roadrunner queue file.", id: "first-step", title: "Build first step" });
    } finally {
      await removeDir(project.directory);
    }
  });

  test("marks provider failures as blocked", async () => {
    const project = await setupRunnerProject("provider-fail");
    try {
      await expect(runRoadrunner(project.context)).rejects.toThrow(/Implementation failed/);

      const queue = await readJson<QueueFile>(project.context.paths.queue);
      expect(queue.queue).toEqual([]);
      expect(queue.blocked[0]).toMatchObject({ blockedReason: "Provider exited 7", id: "first-step" });
    } finally {
      await removeDir(project.directory);
    }
  });

  test("blocks failures using the original queue when provider mutates queue state", async () => {
    const project = await setupRunnerProject("provider-fail-queue-dirty");
    try {
      await expect(runRoadrunner(project.context)).rejects.toThrow(/Implementation may not update/);

      const queue = await readJson<QueueFile>(project.context.paths.queue);
      expect(queue.blocked[0]).toMatchObject({ blockedReason: "Implementation may not update the Roadrunner queue file.", id: "first-step", title: "Build first step" });
    } finally {
      await removeDir(project.directory);
    }
  });

  test("blocks failures using the original queue when the latest queue is invalid", async () => {
    const project = await setupRunnerProject("provider-fail-invalid-queue");
    try {
      await expect(runRoadrunner(project.context)).rejects.toThrow(/Implementation may not update/);

      const queue = await readJson<QueueFile>(project.context.paths.queue);
      expect(queue.version).toBe(2);
      expect(queue.blocked[0]).toMatchObject({ id: "first-step", title: "Build first step" });
      expect(queue.blocked[0]?.blockedReason).toMatch(/Implementation may not update/);
    } finally {
      await removeDir(project.directory);
    }
  });

  test("blocks failures using the original queue when the current step changed", async () => {
    const project = await setupRunnerProject("provider-fail-other-current");
    try {
      await expect(runRoadrunner(project.context)).rejects.toThrow(/Implementation may not update/);

      const queue = await readJson<QueueFile>(project.context.paths.queue);
      expect(queue.blocked[0]).toMatchObject({ blockedReason: "Implementation may not update the Roadrunner queue file.", id: "first-step" });
      expect(queue.queue).toEqual([]);
    } finally {
      await removeDir(project.directory);
    }
  });

  test("returns planning failures as blocked", async () => {
    const project = await setupRunnerProject("plan-fail");
    try {
      await expect(runRoadrunner(project.context)).rejects.toThrow(/Planning failed/);
      const queue = await readJson<QueueFile>(project.context.paths.queue);
      expect(queue.blocked[0]).toMatchObject({ blockedReason: "Planning exited 6", id: "first-step" });
    } finally {
      await removeDir(project.directory);
    }
  });

  test("fixes verification failures once and completes the step", async () => {
    const project = await setupRunnerProject("fix-success");
    try {
      expect(await runRoadrunner(project.context)).toBe(1);
      expect(await readFile(path.join(project.directory, "marker.txt"), "utf8")).toBe("ok\n");
    } finally {
      await removeDir(project.directory);
    }
  });

  test("marks verification failures as blocked when fix fails", async () => {
    const project = await setupRunnerProject("fix-fail");
    try {
      await expect(runRoadrunner(project.context)).rejects.toThrow(/Verification failed/);

      const queue = await readJson<QueueFile>(project.context.paths.queue);
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
