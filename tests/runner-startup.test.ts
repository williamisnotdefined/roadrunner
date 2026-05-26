import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import { run as runRoadrunner, type RoadrunnerRunEvent } from "../src/application/runner.js";
import { removeDir } from "./helpers.js";
import { latestQueueSnapshot, logDirFor, setupRunnerProject } from "./runner-helpers.js";

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
});

describe("runner startup refresh", () => {
  test("returns zero when startup refresh marks roadmap work already done", async () => {
    const project = await setupRunnerProject("startup-refresh-inferred-done");
    const events: RoadrunnerRunEvent[] = [];
    try {
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
      project.context.config.allowedVerificationCommands = [`node -e "require('node:fs').readFileSync('marker.txt', 'utf8').includes('ok') || process.exit(1)"`];

      expect(await runRoadrunner(project.context, { maxSteps: 1, onEvent: (event) => events.push(event) })).toBe(1);
      const queue = latestQueueSnapshot(events);
      expect(queue.history.map((step) => step.id)).toEqual(["strategic-step"]);
    } finally {
      await removeDir(project.directory);
    }
  });

  test("rejects file mutations during startup refresh", async () => {
    const project = await setupRunnerProject("startup-refresh-extra");
    try {
      await expect(runRoadrunner(project.context, { maxSteps: 1 })).rejects.toThrow(/Read-only provider role startup-refresh modified workspace files/);
      expect(await readFile(path.join(project.directory, "unexpected-startup.txt"), "utf8")).toBe("nope\n");
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

  test("rejects new provider-generated verification commands unless allowed", async () => {
    const project = await setupRunnerProject("startup-refresh-from-strategic");
    try {
      await writeFile(project.context.paths.roadmap, `# Strategic Roadmap\n\nBuild the smallest useful marker-backed feature without operational fields.\n`);

      await expect(runRoadrunner(project.context, { maxSteps: 1 })).rejects.toThrow(/verification\[0\] is not trusted/);
    } finally {
      await removeDir(project.directory);
    }
  });

  test("appends the queue proposal contract to local startup prompts", async () => {
    const project = await setupRunnerProject("startup-refresh-inferred-done");
    try {
      await writeFile(
        path.join(project.context.paths.prompts, "startup-refresh.md"),
        "# Roadrunner Startup Queue Refresh\n\n## Seed Queue\n\n```json\n{{QUEUE_JSON}}\n```\n",
      );

      expect(await runRoadrunner(project.context, { maxSteps: 1 })).toBe(0);
      const prompt = await readFile(path.join(await logDirFor(project.context, "startup-refresh"), "startup-refresh.prompt.md"), "utf8");
      expect(prompt).toContain("Required Queue Proposal Output");
      expect(prompt).toContain("roadrunner-queue");
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

      expect(await runRoadrunner(project.context, { maxSteps: 1, onEvent: (event) => events.push(event) })).toBe(0);
      const queue = latestQueueSnapshot(events);
      expect(queue.queue).toEqual([]);
      expect(queue.history).toEqual([]);
    } finally {
      await removeDir(project.directory);
    }
  });
});
