import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import { loadContext, pathExists, readJson, type ProjectContext } from "../src/config.js";
import { parseStatusPaths, plan, run as runRoadrunner, status, verify } from "../src/runner.js";
import type { QueueFile } from "../src/queue.js";
import { commitAll, createFakeOpenCodeBin, createInitializedProject, initGit, removeDir, run, sampleRoadmap, tempDir, withPath } from "./helpers.js";

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
});

describe("runner", () => {
  test("parses git status paths including renames", () => {
    expect(parseStatusPaths(" M file.txt\nR  old.txt -> new.txt\n")).toEqual(["file.txt", "new.txt"]);
    expect(parseStatusPaths(" M file with spaces.txt\0R  new name.txt\0old name.txt\0C  copy.txt\0source.txt\0?? weird -> name.txt\0")).toEqual([
      "file with spaces.txt",
      "new name.txt",
      "copy.txt",
      "weird -> name.txt",
    ]);
  });

  test("plans the current step without skipped permissions", async () => {
    const project = await setupRunnerProject("success");
    try {
      const argsFile = path.join(project.directory, "args.json");
      process.env.ROADRUNNER_FAKE_OPENCODE_ARGS_FILE = argsFile;

      const result = await plan(project.context);

      expect(result?.result.code).toBe(0);
      expect(result?.result.output).toMatch(/Plan:/);
      expect(await readFile(path.join(result!.logDir, "plan.md"), "utf8")).toMatch(/Plan:/);
      expect(JSON.parse(await readFile(argsFile, "utf8"))).not.toContain("--dangerously-skip-permissions");

      project.context.config.model = undefined as never;
      project.context.config.variant = undefined as never;
      expect((await plan(project.context))?.result.code).toBe(0);
    } finally {
      await removeDir(project.directory);
    }
  });

  test("returns null when there is no queued step to plan", async () => {
    const project = await setupRunnerProject("success");
    try {
      const queue = await readJson<QueueFile>(project.context.paths.queue);
      queue.queue = [];
      await writeFile(project.context.paths.queue, `${JSON.stringify(queue, null, 2)}\n`);

      expect(await plan(project.context)).toBeNull();
    } finally {
      await removeDir(project.directory);
    }
  });

  test("verifies commands and returns output", async () => {
    const project = await setupRunnerProject("success");
    try {
      const step = (await readJson<QueueFile>(project.context.paths.queue)).queue[0]!;
      await writeFile(path.join(project.directory, "marker.txt"), "ok\n");

      const ok = await verify(project.context, step, project.context.paths.logs);
      const failed = await verify(project.context, { ...step, verification: ['node -e "process.exit(3)"'] }, project.context.paths.logs);

      expect(ok.ok).toBe(true);
      expect(ok.output).toMatch(/marker.txt/);
      expect(failed.ok).toBe(false);
      expect(failed.output).toMatch(/process.exit/);
    } finally {
      await removeDir(project.directory);
    }
  });

  test("runs a successful step, commits it, and reconciles the queue", async () => {
    const project = await setupRunnerProject("success");
    try {
      const completed = await runRoadrunner(project.context, { maxSteps: 1 });
      const queue = await readJson<QueueFile>(project.context.paths.queue);
      const log = await run("git", ["log", "--oneline"], project.directory);

      expect(completed).toBe(1);
      expect(queue.queue).toEqual([]);
      expect(queue.history.map((step) => step.id)).toEqual(["first-step"]);
      expect(queue.blocked).toEqual([]);
      expect(await readFile(path.join(project.directory, "marker.txt"), "utf8")).toBe("ok\n");
      expect(log.stdout.split("\n").filter(Boolean).length).toBeGreaterThanOrEqual(2);
    } finally {
      await removeDir(project.directory);
    }
  });

  test("reports run progress events", async () => {
    const project = await setupRunnerProject("success");
    const events: string[] = [];
    try {
      await runRoadrunner(project.context, { maxSteps: 1, onEvent: (event) => events.push(event.type) });

      expect(events).toEqual([
        "validate",
        "clean-worktree",
        "step",
        "plan",
        "provider-start",
        "implement",
        "provider-start",
        "verify",
        "commit",
        "reconcile",
        "provider-start",
        "step-complete",
        "cleanup",
      ]);
    } finally {
      await removeDir(project.directory);
    }
  });

  test("returns zero when maxHours deadline has already passed", async () => {
    const project = await setupRunnerProject("success");
    try {
      expect(await runRoadrunner(project.context, { maxHours: 0, maxSteps: 1 })).toBe(0);
    } finally {
      await removeDir(project.directory);
    }
  });

  test("returns zero when no queued steps are available", async () => {
    const project = await setupRunnerProject("success");
    try {
      const queue = await readJson<QueueFile>(project.context.paths.queue);
      queue.queue = [];
      await writeFile(project.context.paths.queue, `${JSON.stringify(queue, null, 2)}\n`);
      await commitAll(project.directory, "Empty queue");

      expect(await runRoadrunner(project.context)).toBe(0);
    } finally {
      await removeDir(project.directory);
    }
  });

  test("status rejects invalid project state", async () => {
    const project = await setupRunnerProject("success");
    try {
      await writeFile(project.context.paths.queue, `${JSON.stringify({ version: 1 }, null, 2)}\n`);

      await expect(status(project.context)).rejects.toThrow(/queue.version must be 2/);
    } finally {
      await removeDir(project.directory);
    }
  });

  test("status falls back to default model and variant", async () => {
    const project = await setupRunnerProject("success");
    try {
      project.context.config.model = undefined as never;
      project.context.config.variant = undefined as never;

      expect((await status(project.context)).queued).toBe(1);
    } finally {
      await removeDir(project.directory);
    }
  });

  test("run rejects invalid project state before agents", async () => {
    const project = await setupRunnerProject("success");
    try {
      await writeFile(project.context.paths.queue, `${JSON.stringify({ version: 1 }, null, 2)}\n`);

      await expect(runRoadrunner(project.context)).rejects.toThrow(/queue.version must be 2/);
    } finally {
      await removeDir(project.directory);
    }
  });

  test("requires a clean worktree", async () => {
    const project = await setupRunnerProject("success");
    try {
      await writeFile(path.join(project.directory, "dirty.txt"), "dirty\n");

      await expect(runRoadrunner(project.context)).rejects.toThrow(/clean git worktree/);
    } finally {
      await removeDir(project.directory);
    }
  });

  test("rejects planning agents that change files", async () => {
    const project = await setupRunnerProject("plan-dirty");
    try {
      await expect(runRoadrunner(project.context)).rejects.toThrow(/Planning changed files: plan-dirty.txt/);
    } finally {
      await removeDir(project.directory);
    }
  });

  test("rejects provider changes to GOALS.md", async () => {
    const project = await setupRunnerProject("goals-dirty");
    try {
      await expect(runRoadrunner(project.context)).rejects.toThrow(/GOALS\.md is read-only/);
      const queue = await readJson<QueueFile>(project.context.paths.queue);
      expect(queue.queue.map((step) => step.id)).toEqual(["first-step"]);
      expect(queue.history).toEqual([]);
    } finally {
      await removeDir(project.directory);
    }
  });

  test("reports renamed dirty files during preflight", async () => {
    const project = await setupRunnerProject("success");
    try {
      await writeFile(path.join(project.directory, "old.txt"), "old\n");
      await commitAll(project.directory, "Add old file");
      await run("git", ["mv", "old.txt", "new.txt"], project.directory);

      await expect(runRoadrunner(project.context)).rejects.toThrow(/clean git worktree/);
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

  test("stops when planning fails", async () => {
    const project = await setupRunnerProject("plan-fail");
    try {
      await expect(runRoadrunner(project.context)).rejects.toThrow(/Planning failed/);
    } finally {
      await removeDir(project.directory);
    }
  });

  test("reports git add failures", async () => {
    const project = await setupRunnerProject("success");
    try {
      await writeFile(path.join(project.directory, ".git/index.lock"), "locked\n");

      await expect(runRoadrunner(project.context)).rejects.toThrow(/git add failed/);
      const queue = await readJson<QueueFile>(project.context.paths.queue);
      expect(queue.queue.map((step) => step.id)).toEqual(["first-step"]);
      expect(queue.history).toEqual([]);
    } finally {
      await removeDir(project.directory);
    }
  });

  test("reports git commit failures", async () => {
    const project = await setupRunnerProject("success");
    try {
      const hookPath = path.join(project.directory, ".git/hooks/pre-commit");
      await writeFile(hookPath, "#!/bin/sh\nexit 1\n", { mode: 0o755 });

      await expect(runRoadrunner(project.context)).rejects.toThrow(/git commit failed/);
      const queue = await readJson<QueueFile>(project.context.paths.queue);
      expect(queue.queue.map((step) => step.id)).toEqual(["first-step"]);
      expect(queue.history).toEqual([]);
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

  test("rejects reconciliation changes outside the queue", async () => {
    const project = await setupRunnerProject("reconcile-extra");
    try {
      await expect(runRoadrunner(project.context)).rejects.toThrow(/outside .roadrunner\/queue.json/);
      expect(await pathExists(path.join(project.directory, "unexpected.txt"))).toBe(false);
      expect((await run("git", ["status", "--short"], project.directory)).stdout).toBe("");
    } finally {
      await removeDir(project.directory);
    }
  });

  test("commits valid queue-only reconciliation changes", async () => {
    const project = await setupRunnerProject("reconcile-queue");
    try {
      expect(await runRoadrunner(project.context)).toBe(1);
      const queue = await readJson<QueueFile>(project.context.paths.queue);
      const log = await run("git", ["log", "--oneline"], project.directory);

      expect(queue.source).toBe("reconciled-roadmap.md");
      expect(log.stdout).toMatch(/Reconcile Roadrunner queue/);
    } finally {
      await removeDir(project.directory);
    }
  });

  test("rejects dirty worktrees before reconciliation", async () => {
    const project = await setupRunnerProject("success");
    try {
      const hookPath = path.join(project.directory, ".git/hooks/post-commit");
      await writeFile(hookPath, "#!/bin/sh\nprintf dirty > post-commit-dirty.txt\n", { mode: 0o755 });

      await expect(runRoadrunner(project.context)).rejects.toThrow(/Expected clean worktree before reconciliation/);
    } finally {
      await removeDir(project.directory);
    }
  });

  test("restores queue-only reconciliation changes when the reconcile commit fails", async () => {
    const project = await setupRunnerProject("reconcile-queue");
    try {
      const hookPath = path.join(project.directory, ".git/hooks/commit-msg");
      await writeFile(hookPath, "#!/bin/sh\ngrep -q 'Reconcile Roadrunner queue' \"$1\" && exit 1\nexit 0\n", { mode: 0o755 });

      await expect(runRoadrunner(project.context)).rejects.toThrow(/git commit failed for reconcile-commit/);
      const queue = await readJson<QueueFile>(project.context.paths.queue);
      expect(queue.source).toBe("ROADMAP.md");
      expect(queue.history.map((step) => step.id)).toEqual(["first-step"]);
      expect((await run("git", ["status", "--short"], project.directory)).stdout).toBe("");
    } finally {
      await removeDir(project.directory);
    }
  });

  test("rejects failed reconciliation provider runs", async () => {
    const project = await setupRunnerProject("reconcile-fail");
    try {
      await expect(runRoadrunner(project.context)).rejects.toThrow(/Reconciliation failed/);
    } finally {
      await removeDir(project.directory);
    }
  });

  test("cleans changes from failed reconciliation provider runs", async () => {
    const project = await setupRunnerProject("reconcile-fail-dirty");
    try {
      await expect(runRoadrunner(project.context)).rejects.toThrow(/Reconciliation failed/);
      expect(await pathExists(path.join(project.directory, "unexpected.txt"))).toBe(false);
      expect((await run("git", ["status", "--short"], project.directory)).stdout).toBe("");
    } finally {
      await removeDir(project.directory);
    }
  });

  test("rejects invalid queue produced during reconciliation", async () => {
    const project = await setupRunnerProject("reconcile-invalid");
    try {
      await expect(runRoadrunner(project.context)).rejects.toThrow(/queue.version must be 2/);
      expect((await readJson<QueueFile>(project.context.paths.queue)).version).toBe(2);
      expect((await run("git", ["status", "--short"], project.directory)).stdout).toBe("");
    } finally {
      await removeDir(project.directory);
    }
  });

  test("rejects unsupported providers", async () => {
    const project = await setupRunnerProject("success");
    try {
      project.context.config.provider = "other";
      await expect(plan(project.context)).rejects.toThrow(/Unsupported provider/);
    } finally {
      await removeDir(project.directory);
    }
  });
});

async function setupRunnerProject(mode: string): Promise<{ context: ProjectContext; directory: string }> {
  const directory = await tempDir("roadrunner-runner-");
  const binDir = await createFakeOpenCodeBin(directory);
  process.env.PATH = withPath(binDir);
  process.env.ROADRUNNER_FAKE_OPENCODE_MODE = mode;
  delete process.env.OPENCODE_SESSION;
  delete process.env.OPENCODE_SESSION_ID;
  delete process.env.OPENCODE_SERVER;
  delete process.env.OPENCODE_WORKSPACE;
  delete process.env.OPENCODE_APP_INFO;

  await createInitializedProject(directory, sampleRoadmap());
  await initGit(directory);
  await commitAll(directory, "Initial project");
  const context = await loadContext(directory, { _: [] });
  context.config.allowNestedOpenCode = true;
  return { context, directory };
}
