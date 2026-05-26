import { rmSync, writeFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { afterEach, describe, expect, test } from "vitest";

import { pathExists, readJson, writeJson } from "../src/infrastructure/config.js";
import type { QueueFile } from "../src/domain/queue.js";
import { plan, run as runRoadrunner } from "../src/application/runner.js";
import { removeDir } from "./helpers.js";
import { setupRunnerProject } from "./runner-helpers.js";

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
});

describe("runner locks", () => {
  test("rejects concurrent runs with an active lock", async () => {
    const project = await setupRunnerProject("startup-refresh-inferred-done");
    try {
      await writeFile(project.context.paths.lock, `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }, null, 2)}\n`);

      await expect(runRoadrunner(project.context)).rejects.toThrow(/run lock already exists/);
    } finally {
      await removeDir(project.directory);
    }
  });

  test("rejects standalone planning with an active lock", async () => {
    const project = await setupRunnerProject("startup-refresh-inferred-done");
    try {
      await writeFile(project.context.paths.lock, `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }, null, 2)}\n`);

      await expect(plan(project.context)).rejects.toThrow(/Roadrunner plan lock already exists/);
    } finally {
      await removeDir(project.directory);
    }
  });

  test("rejects corrupt run locks", async () => {
    const project = await setupRunnerProject("startup-refresh-inferred-done");
    try {
      await writeFile(project.context.paths.lock, "not json\n");

      await expect(runRoadrunner(project.context)).rejects.toThrow(/run lock already exists/);
    } finally {
      await removeDir(project.directory);
    }
  });

  test("removes stale run locks", async () => {
    const project = await setupRunnerProject("startup-refresh-inferred-done");
    try {
      const queue = await readJson<QueueFile>(project.context.paths.queue);
      queue.queue = [];
      await writeJson(project.context.paths.queue, queue);
      await writeFile(project.context.paths.lock, `${JSON.stringify({ pid: 99999999, startedAt: new Date().toISOString() }, null, 2)}\n`);

      expect(await runRoadrunner(project.context)).toBe(0);
      expect(await pathExists(project.context.paths.lock)).toBe(false);
    } finally {
      await removeDir(project.directory);
    }
  });

  test("removes run locks whose pid has been reused", async () => {
    const project = await setupRunnerProject("startup-refresh-inferred-done");
    try {
      const queue = await readJson<QueueFile>(project.context.paths.queue);
      queue.queue = [];
      await writeJson(project.context.paths.queue, queue);
      await writeFile(project.context.paths.lock, `${JSON.stringify({ pid: process.pid, startedAt: "old-lock", startTimeTicks: "definitely-not-current" }, null, 2)}\n`);

      expect(await runRoadrunner(project.context)).toBe(0);
      expect(await pathExists(project.context.paths.lock)).toBe(false);
    } finally {
      await removeDir(project.directory);
    }
  });

  test("does not remove a replacement run lock on release", async () => {
    const project = await setupRunnerProject("startup-refresh-inferred-done");
    try {
      const queue = await readJson<QueueFile>(project.context.paths.queue);
      queue.queue = [];
      await writeJson(project.context.paths.queue, queue);
      const replacementLock = { pid: process.pid, startedAt: "replacement-lock" };

      expect(
        await runRoadrunner(project.context, {
          onEvent: (event) => {
            if (event.type === "validate") writeFileSync(project.context.paths.lock, `${JSON.stringify(replacementLock, null, 2)}\n`);
          },
        }),
      ).toBe(0);
      expect(await readJson(project.context.paths.lock)).toEqual(replacementLock);
    } finally {
      await removeDir(project.directory);
    }
  });

  test("does not remove a corrupt replacement run lock on release", async () => {
    const project = await setupRunnerProject("startup-refresh-inferred-done");
    try {
      const queue = await readJson<QueueFile>(project.context.paths.queue);
      queue.queue = [];
      await writeJson(project.context.paths.queue, queue);

      expect(
        await runRoadrunner(project.context, {
          onEvent: (event) => {
            if (event.type === "validate") writeFileSync(project.context.paths.lock, "not json\n");
          },
        }),
      ).toBe(0);
      expect(await readFile(project.context.paths.lock, "utf8")).toBe("not json\n");
    } finally {
      await removeDir(project.directory);
    }
  });

  test("handles a missing run lock on release", async () => {
    const project = await setupRunnerProject("startup-refresh-inferred-done");
    try {
      const queue = await readJson<QueueFile>(project.context.paths.queue);
      queue.queue = [];
      await writeJson(project.context.paths.queue, queue);

      expect(
        await runRoadrunner(project.context, {
          onEvent: (event) => {
            if (event.type === "validate") rmSync(project.context.paths.lock, { force: true });
          },
        }),
      ).toBe(0);
      expect(await pathExists(project.context.paths.lock)).toBe(false);
    } finally {
      await removeDir(project.directory);
    }
  });
});
