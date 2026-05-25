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
      const argsFile = path.join(project.context.paths.logs, "args.json");
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
      await expect(verify(project.context, step, project.context.paths.logs, { deadline: Date.now() - 1 })).rejects.toThrow(/deadline/);
      process.env.ROADRUNNER_VERIFY_TIMEOUT_MS = "bad";
      await expect(verify(project.context, step, project.context.paths.logs)).rejects.toThrow(/ROADRUNNER_VERIFY_TIMEOUT_MS/);
      delete process.env.ROADRUNNER_VERIFY_TIMEOUT_MS;
    } finally {
      await removeDir(project.directory);
    }
  });

  test("runs a successful step, commits it, and reconciles the queue", async () => {
    const project = await setupRunnerProject("success");
    try {
      process.env.ROADRUNNER_PROVIDER_TIMEOUT_MS = "100000";
      process.env.ROADRUNNER_VERIFY_TIMEOUT_MS = "0";
      const completed = await runRoadrunner(project.context, { maxHours: 1, maxSteps: 1 });
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

  test("blocks a queue-only step when implementation makes no file changes", async () => {
    const project = await setupRunnerProject("noop", sampleRoadmap({ verification: 'node -e "process.exit(0)"' }));
    try {
      await expect(runRoadrunner(project.context, { maxSteps: 1 })).rejects.toThrow(/no project changes/);
      const queue = await readJson<QueueFile>(project.context.paths.queue);
      expect(queue.history).toEqual([]);
      expect(queue.blocked[0]).toMatchObject({ blockedReason: "Implementation produced no project changes.", id: "first-step" });
    } finally {
      await removeDir(project.directory);
    }
  });

  test("reports run progress events", async () => {
    const project = await setupRunnerProject("success");
    const events: string[] = [];
    try {
      await runRoadrunner(project.context, { maxHours: 1, maxSteps: 1, onEvent: (event) => events.push(event.type) });

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

  test("rejects verification commands that mutate files", async () => {
    const project = await setupRunnerProject("success", sampleRoadmap({ verification: "node -e \"require('node:fs').writeFileSync('verify-dirty.txt', 'dirty\\n')\"" }));
    try {
      await expect(runRoadrunner(project.context)).rejects.toThrow(/Verification changed files/);
      const queue = await readJson<QueueFile>(project.context.paths.queue);
      expect(queue.blocked[0]).toMatchObject({ blockedReason: "Verification changed files.", id: "first-step" });
      expect((await run("git", ["status", "--short"], project.directory)).stdout).toBe("");
    } finally {
      await removeDir(project.directory);
    }
  });

  test("rejects verification commands that mutate untracked file content", async () => {
    const project = await setupRunnerProject("success", sampleRoadmap({ verification: "node -e \"require('node:fs').writeFileSync('marker.txt', 'mutated\\n')\"" }));
    try {
      await expect(runRoadrunner(project.context)).rejects.toThrow(/Verification changed files/);
      const queue = await readJson<QueueFile>(project.context.paths.queue);
      expect(queue.blocked[0]).toMatchObject({ blockedReason: "Verification changed files.", id: "first-step" });
      expect((await run("git", ["status", "--short"], project.directory)).stdout).toBe("");
    } finally {
      await removeDir(project.directory);
    }
  });

  test("rejects verification commands that commit changes", async () => {
    const verification = `node -e "const fs = require('node:fs'); const cp = require('node:child_process'); fs.writeFileSync('verify-commit.txt', 'bad\\n'); cp.execFileSync(process.env.ROADRUNNER_TEST_REAL_GIT || '/usr/bin/git', ['add', 'verify-commit.txt']); cp.execFileSync(process.env.ROADRUNNER_TEST_REAL_GIT || '/usr/bin/git', ['commit', '-m', 'Verify commit']);"`;
    const project = await setupRunnerProject("success", sampleRoadmap({ verification }));
    try {
      await expect(runRoadrunner(project.context)).rejects.toThrow(/Verification changed git history/);
      const queue = await readJson<QueueFile>(project.context.paths.queue);
      expect(queue.blocked[0]).toMatchObject({ blockedReason: "Verification changed git history.", id: "first-step" });
      expect(await pathExists(path.join(project.directory, "verify-commit.txt"))).toBe(false);
      expect((await run("git", ["log", "--oneline", "--grep", "Verify commit"], project.directory)).stdout).toBe("");
      expect((await run("git", ["status", "--short"], project.directory)).stdout).toBe("");
    } finally {
      await removeDir(project.directory);
    }
  });

  test("times out verification commands", async () => {
    process.env.ROADRUNNER_VERIFY_TIMEOUT_MS = "50";
    const project = await setupRunnerProject("fix-fail", sampleRoadmap({ verification: 'node -e "Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0)"' }));
    try {
      await expect(runRoadrunner(project.context)).rejects.toThrow(/Verification failed/);
      const queue = await readJson<QueueFile>(project.context.paths.queue);
      expect(queue.blocked[0]).toMatchObject({ id: "first-step" });
      expect((await readFile(path.join(project.context.paths.logs, "preflight-git-status.log"), "utf8")).length).toBeGreaterThanOrEqual(0);
    } finally {
      await removeDir(project.directory);
    }
  });

  test("rejects concurrent runs with an active lock", async () => {
    const project = await setupRunnerProject("success");
    try {
      await writeFile(project.context.paths.lock, `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }, null, 2)}\n`);

      await expect(runRoadrunner(project.context)).rejects.toThrow(/run lock already exists/);
    } finally {
      await removeDir(project.directory);
    }
  });

  test("removes stale run locks", async () => {
    const project = await setupRunnerProject("success");
    try {
      const queue = await readJson<QueueFile>(project.context.paths.queue);
      queue.queue = [];
      await writeFile(project.context.paths.queue, `${JSON.stringify(queue, null, 2)}\n`);
      await commitAll(project.directory, "Empty queue");
      await writeFile(project.context.paths.lock, `${JSON.stringify({ pid: 99999999, startedAt: new Date().toISOString() }, null, 2)}\n`);

      expect(await runRoadrunner(project.context)).toBe(0);
      expect(await pathExists(project.context.paths.lock)).toBe(false);
    } finally {
      await removeDir(project.directory);
    }
  });

  test("rejects provider changes to GOALS.md", async () => {
    const project = await setupRunnerProject("goals-dirty");
    try {
      await expect(runRoadrunner(project.context)).rejects.toThrow(/GOALS\.md is read-only/);
      const queue = await readJson<QueueFile>(project.context.paths.queue);
      expect(queue.queue).toEqual([]);
      expect(queue.blocked[0]).toMatchObject({ id: "first-step" });
      expect((await run("git", ["status", "--short"], project.directory)).stdout).toBe("");
    } finally {
      await removeDir(project.directory);
    }
  });

  test("blocks provider commits through the git guard", async () => {
    const project = await setupRunnerProject("git-commit");
    try {
      await expect(runRoadrunner(project.context)).rejects.toThrow(/Implementation failed/);
      const queue = await readJson<QueueFile>(project.context.paths.queue);
      expect(queue.blocked[0]).toMatchObject({ blockedReason: "Provider exited 126", id: "first-step" });
      expect((await run("git", ["log", "--oneline", "--grep", "Agent commit"], project.directory)).stdout).toBe("");
      expect((await run("git", ["status", "--short"], project.directory)).stdout).toBe("");
    } finally {
      await removeDir(project.directory);
    }
  });

  test("blocks provider pushes through the git guard", async () => {
    const project = await setupRunnerProject("git-push");
    try {
      await expect(runRoadrunner(project.context)).rejects.toThrow(/Implementation failed/);
      const queue = await readJson<QueueFile>(project.context.paths.queue);
      expect(queue.blocked[0]).toMatchObject({ blockedReason: "Provider exited 126", id: "first-step" });
      expect((await run("git", ["status", "--short"], project.directory)).stdout).toBe("");
    } finally {
      await removeDir(project.directory);
    }
  });

  test("rejects provider commits that bypass the git guard", async () => {
    const project = await setupRunnerProject("implementation-commit-bypass");
    try {
      await run("git", ["tag", "baseline-tag"], project.directory);

      await expect(runRoadrunner(project.context)).rejects.toThrow(/Implementation changed git history/);
      const queue = await readJson<QueueFile>(project.context.paths.queue);
      expect(queue.blocked[0]).toMatchObject({ blockedReason: "Implementation changed git history.", id: "first-step" });
      expect(await pathExists(path.join(project.directory, "marker.txt"))).toBe(false);
      expect((await run("git", ["log", "--oneline", "--grep", "Agent implementation commit"], project.directory)).stdout).toBe("");
      expect((await run("git", ["rev-list", "-n", "1", "baseline-tag"], project.directory)).stdout).toBe((await run("git", ["rev-parse", "HEAD~1"], project.directory)).stdout);
      expect((await run("git", ["status", "--short"], project.directory)).stdout).toBe("");
    } finally {
      await removeDir(project.directory);
    }
  });

  test("rejects committed provider changes to GOALS.md", async () => {
    const project = await setupRunnerProject("goals-commit-bypass");
    try {
      await expect(runRoadrunner(project.context)).rejects.toThrow(/Implementation changed git history/);
      const queue = await readJson<QueueFile>(project.context.paths.queue);
      expect(queue.blocked[0]).toMatchObject({ blockedReason: "Implementation changed git history.", id: "first-step" });
      expect(await readFile(path.join(project.directory, "GOALS.md"), "utf8")).toMatch(/Build the requested project/);
      expect((await run("git", ["log", "--oneline", "--grep", "Agent changed goals"], project.directory)).stdout).toBe("");
      expect((await run("git", ["status", "--short"], project.directory)).stdout).toBe("");
    } finally {
      await removeDir(project.directory);
    }
  });

  test("restores unauthorized commits when starting from detached HEAD", async () => {
    const project = await setupRunnerProject("implementation-commit-bypass");
    try {
      await run("git", ["checkout", "--detach", "HEAD"], project.directory);

      await expect(runRoadrunner(project.context)).rejects.toThrow(/Implementation changed git history/);
      const queue = await readJson<QueueFile>(project.context.paths.queue);
      expect(queue.blocked[0]).toMatchObject({ blockedReason: "Implementation changed git history.", id: "first-step" });
      expect((await run("git", ["log", "--oneline", "--grep", "Agent implementation commit"], project.directory)).stdout).toBe("");
      expect((await run("git", ["status", "--short"], project.directory)).stdout).toBe("");
    } finally {
      await removeDir(project.directory);
    }
  });

  test("rejects implementation agents that mutate queue state", async () => {
    const project = await setupRunnerProject("queue-dirty");
    try {
      await expect(runRoadrunner(project.context)).rejects.toThrow(/Implementation changed Roadrunner queue state directly/);
      const queue = await readJson<QueueFile>(project.context.paths.queue);
      expect(queue.blocked[0]?.blockedReason).toMatch(/Implementation changed Roadrunner queue state directly/);
      expect((await run("git", ["status", "--short"], project.directory)).stdout).toBe("");
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

  test("rejects fix agents that commit changes", async () => {
    const project = await setupRunnerProject("fix-commit-bypass");
    try {
      await expect(runRoadrunner(project.context)).rejects.toThrow(/Fix failure changed git history/);
      const queue = await readJson<QueueFile>(project.context.paths.queue);
      expect(queue.blocked[0]).toMatchObject({ blockedReason: "Fix failure changed git history.", id: "first-step" });
      expect((await run("git", ["log", "--oneline", "--grep", "Agent fix commit"], project.directory)).stdout).toBe("");
      expect((await run("git", ["status", "--short"], project.directory)).stdout).toBe("");
    } finally {
      await removeDir(project.directory);
    }
  });

  test("rejects fixed verification commands that commit changes", async () => {
    const verification = `node -e "const fs = require('node:fs'); const cp = require('node:child_process'); if (!fs.readFileSync('marker.txt', 'utf8').includes('ok')) process.exit(1); fs.writeFileSync('verify-fixed-commit.txt', 'bad\\n'); cp.execFileSync(process.env.ROADRUNNER_TEST_REAL_GIT || '/usr/bin/git', ['add', 'verify-fixed-commit.txt']); cp.execFileSync(process.env.ROADRUNNER_TEST_REAL_GIT || '/usr/bin/git', ['commit', '-m', 'Verify fixed commit']);"`;
    const project = await setupRunnerProject("fix-success", sampleRoadmap({ verification }));
    try {
      await expect(runRoadrunner(project.context)).rejects.toThrow(/Verification changed git history/);
      const queue = await readJson<QueueFile>(project.context.paths.queue);
      expect(queue.blocked[0]).toMatchObject({ blockedReason: "Verification changed git history.", id: "first-step" });
      expect(await pathExists(path.join(project.directory, "verify-fixed-commit.txt"))).toBe(false);
      expect((await run("git", ["log", "--oneline", "--grep", "Verify fixed commit"], project.directory)).stdout).toBe("");
      expect((await run("git", ["status", "--short"], project.directory)).stdout).toBe("");
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

  test("rejects reconciliation commits outside Roadrunner", async () => {
    const project = await setupRunnerProject("reconcile-commit-bypass");
    try {
      await expect(runRoadrunner(project.context)).rejects.toThrow(/Reconciliation changed git history/);
      const queue = await readJson<QueueFile>(project.context.paths.queue);
      expect(queue.blocked[0]).toMatchObject({ blockedReason: "Reconciliation failed: Reconciliation changed git history.", id: "first-step" });
      expect(await pathExists(path.join(project.directory, "unexpected.txt"))).toBe(false);
      expect((await run("git", ["log", "--oneline", "--grep", "Agent reconcile commit"], project.directory)).stdout).toBe("");
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
      expect(log.stdout).toMatch(/Complete Roadrunner step first-step/);
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
      await writeFile(project.context.paths.queue, `${JSON.stringify(queue, null, 2)}\n`);
      await commitAll(project.directory, "Seed closed queue records");

      await expect(runRoadrunner(project.context)).rejects.toThrow(/preserve history records/);
      const nextQueue = await readJson<QueueFile>(project.context.paths.queue);
      expect(nextQueue.history.map((step) => step.id)).toEqual(["completed-step"]);
      expect(nextQueue.blocked.map((step) => step.id)).toEqual(["blocked-step", "first-step"]);
      expect((await run("git", ["status", "--short"], project.directory)).stdout).toBe("");
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
      await writeFile(hookPath, "#!/bin/sh\ngrep -q 'Complete Roadrunner step' \"$1\" && exit 1\nexit 0\n", { mode: 0o755 });

      await expect(runRoadrunner(project.context)).rejects.toThrow(/git commit failed for queue-commit/);
      const queue = await readJson<QueueFile>(project.context.paths.queue);
      expect(queue.source).toBe("ROADMAP.md");
      expect(queue.history).toEqual([]);
      expect(queue.blocked[0]).toMatchObject({ id: "first-step" });
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

async function setupRunnerProject(mode: string, roadmap = sampleRoadmap()): Promise<{ context: ProjectContext; directory: string }> {
  const directory = await tempDir("roadrunner-runner-");
  const binDir = await createFakeOpenCodeBin(directory);
  process.env.PATH = withPath(binDir);
  process.env.ROADRUNNER_FAKE_OPENCODE_MODE = mode;
  process.env.ROADRUNNER_TEST_REAL_GIT = "/usr/bin/git";
  delete process.env.OPENCODE_SESSION;
  delete process.env.OPENCODE_SESSION_ID;
  delete process.env.OPENCODE_SERVER;
  delete process.env.OPENCODE_WORKSPACE;
  delete process.env.OPENCODE_APP_INFO;

  await createInitializedProject(directory, roadmap);
  await initGit(directory);
  await commitAll(directory, "Initial project");
  const context = await loadContext(directory, { _: [] });
  context.config.allowNestedOpenCode = true;
  return { context, directory };
}
