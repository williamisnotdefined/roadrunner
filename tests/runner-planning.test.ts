import { readFile, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import { loadContext, readJson } from "../src/config.js";
import type { QueueFile } from "../src/queue.js";
import { plan, run as runRoadrunner } from "../src/runner.js";
import { commitAll, createFakeOpenCodeBin, createInitializedProject, initGit, removeDir, tempDir, withPath } from "./helpers.js";
import { setupRunnerProject } from "./runner-helpers.js";

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
});

describe("runner planning", () => {
  test("blocks planning agents that change files", async () => {
    const project = await setupRunnerProject("plan-dirty");
    try {
      await expect(runRoadrunner(project.context)).rejects.toThrow(/Planning failed/);
      expect(await readFile(path.join(project.directory, "plan-dirty.txt"), "utf8")).toBe("nope\n");
      const queue = await readJson<QueueFile>(project.context.paths.queue);
      expect(queue.blocked[0]).toMatchObject({ blockedReason: "Planning exited 1", id: "first-step" });
    } finally {
      await removeDir(project.directory);
    }
  });

  test("blocks planning agents that delete tracked files", async () => {
    const project = await setupRunnerProject("plan-delete");
    try {
      await writeFile(path.join(project.directory, "delete-me.txt"), "remove me\n");
      await commitAll(project.directory, "Add file deleted by planning");

      await expect(runRoadrunner(project.context)).rejects.toThrow(/Planning failed/);
      const queue = await readJson<QueueFile>(project.context.paths.queue);
      expect(queue.blocked[0]).toMatchObject({ blockedReason: "Planning exited 1", id: "first-step" });
    } finally {
      await removeDir(project.directory);
    }
  });

  test("blocks planning agents that change git-ignored files", async () => {
    const project = await setupRunnerProject("plan-ignored-dirty");
    try {
      await writeFile(path.join(project.directory, ".gitignore"), ".env\n");
      await commitAll(project.directory, "Ignore local env files");

      await expect(runRoadrunner(project.context)).rejects.toThrow(/Planning failed/);
      expect(await readFile(path.join(project.directory, ".env"), "utf8")).toBe("SECRET=changed\n");
      const queue = await readJson<QueueFile>(project.context.paths.queue);
      expect(queue.blocked[0]).toMatchObject({ blockedReason: "Planning exited 1", id: "first-step" });
    } finally {
      await removeDir(project.directory);
    }
  });

  test("plans in git repositories without commits", async () => {
    const directory = await tempDir("roadrunner-runner-unborn-git-");
    try {
      const binDir = await createFakeOpenCodeBin(directory);
      process.env.PATH = withPath(binDir);
      process.env.ROADRUNNER_FAKE_OPENCODE_MODE = "success";
      await createInitializedProject(directory);
      await initGit(directory);
      const context = await loadContext(directory, { _: [] });
      context.config.allowNestedOpenCode = true;

      expect((await plan(context))?.result.code).toBe(0);
    } finally {
      await removeDir(directory);
    }
  });

  test("plans outside git repositories", async () => {
    const directory = await tempDir("roadrunner-runner-no-git-");
    try {
      const binDir = await createFakeOpenCodeBin(directory);
      process.env.PATH = withPath(binDir);
      process.env.ROADRUNNER_FAKE_OPENCODE_MODE = "success";
      const context = await createInitializedProject(directory);

      expect((await plan(context))?.result.code).toBe(0);
    } finally {
      await removeDir(directory);
    }
  });

  test("plans outside git repositories with symlinks", async () => {
    const directory = await tempDir("roadrunner-runner-no-git-symlink-");
    try {
      const binDir = await createFakeOpenCodeBin(directory);
      process.env.PATH = withPath(binDir);
      process.env.ROADRUNNER_FAKE_OPENCODE_MODE = "success";
      const context = await createInitializedProject(directory);
      await writeFile(path.join(directory, "target.txt"), "target\n");
      await symlink("target.txt", path.join(directory, "link.txt"));

      expect((await plan(context))?.result.code).toBe(0);
    } finally {
      await removeDir(directory);
    }
  });

  test("blocks planning agents that change files outside git repositories", async () => {
    const directory = await tempDir("roadrunner-runner-no-git-plan-dirty-");
    try {
      const binDir = await createFakeOpenCodeBin(directory);
      process.env.PATH = withPath(binDir);
      process.env.ROADRUNNER_FAKE_OPENCODE_MODE = "plan-dirty";
      const context = await createInitializedProject(directory);

      await expect(runRoadrunner(context)).rejects.toThrow(/Planning failed/);
      const queue = await readJson<QueueFile>(context.paths.queue);
      expect(queue.blocked[0]).toMatchObject({ blockedReason: "Planning exited 1", id: "first-step" });
    } finally {
      await removeDir(directory);
    }
  });
});
