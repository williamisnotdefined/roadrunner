import { readFile, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import { loadContext } from "../src/infrastructure/config.js";
import { plan, run as runRoadrunner } from "../src/application/runner.js";
import { commitAll, createFakeOpenCodeBin, createInitializedProject, initGit, removeDir, tempDir, withPath } from "./helpers.js";
import { setupRunnerProject } from "./runner-helpers.js";

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
});

describe("runner planning", () => {
  test("does not use file fingerprints to police planning agents", async () => {
    const project = await setupRunnerProject("plan-dirty");
    try {
      expect(await runRoadrunner(project.context)).toBe(1);
      expect(await readFile(path.join(project.directory, "plan-dirty.txt"), "utf8")).toBe("nope\n");
    } finally {
      await removeDir(project.directory);
    }
  });

  test("does not use git state to police planning agents", async () => {
    const project = await setupRunnerProject("plan-delete");
    try {
      await writeFile(path.join(project.directory, "delete-me.txt"), "remove me\n");
      await commitAll(project.directory, "Add file deleted by planning");

      expect(await runRoadrunner(project.context)).toBe(1);
    } finally {
      await removeDir(project.directory);
    }
  });

  test("does not inspect git-ignored files during planning", async () => {
    const project = await setupRunnerProject("plan-ignored-dirty");
    try {
      await writeFile(path.join(project.directory, ".gitignore"), ".env\n");
      await commitAll(project.directory, "Ignore local env files");

      expect(await runRoadrunner(project.context)).toBe(1);
      expect(await readFile(path.join(project.directory, ".env"), "utf8")).toBe("SECRET=changed\n");
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

  test("does not fingerprint planning outside git repositories", async () => {
    const directory = await tempDir("roadrunner-runner-no-git-plan-dirty-");
    try {
      const binDir = await createFakeOpenCodeBin(directory);
      process.env.PATH = withPath(binDir);
      process.env.ROADRUNNER_FAKE_OPENCODE_MODE = "plan-dirty";
      const context = await createInitializedProject(directory);

      expect(await runRoadrunner(context)).toBe(1);
    } finally {
      await removeDir(directory);
    }
  });
});
