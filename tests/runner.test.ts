import { rmSync, writeFileSync } from "node:fs";
import { readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import { loadContext, pathExists, readJson, type ProjectContext, writeJson } from "../src/config.js";
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
      expect(await fileMode(result!.logDir)).toBe(0o700);
      expect(await fileMode(path.join(result!.logDir, "plan.prompt.md"))).toBe(0o600);
      expect(await fileMode(path.join(result!.logDir, "plan.md"))).toBe(0o600);
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
      await writeJson(project.context.paths.queue, queue);

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
      process.env.ROADRUNNER_VERIFY_TIMEOUT_MS = "0";
      expect((await verify(project.context, step, project.context.paths.logs)).ok).toBe(true);
      process.env.ROADRUNNER_VERIFY_TIMEOUT_MS = "bad";
      await expect(verify(project.context, step, project.context.paths.logs)).rejects.toThrow(/ROADRUNNER_VERIFY_TIMEOUT_MS/);
      delete process.env.ROADRUNNER_VERIFY_TIMEOUT_MS;
    } finally {
      await removeDir(project.directory);
    }
  });

  test("runs a successful step and reconciles the queue without committing", async () => {
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
      expect(log.stdout).not.toMatch(/Complete Roadrunner step|Build first step/);
      const stepLogDir = await logDirFor(project.context, "first-step");
      expect(await fileMode(stepLogDir)).toBe(0o700);
      expect(await fileMode(path.join(stepLogDir, "implement.prompt.md"))).toBe(0o600);
      expect(await fileMode(path.join(stepLogDir, "verify-1.log"))).toBe(0o600);
      expect(await fileMode(path.join(stepLogDir, "reconcile.prompt.md"))).toBe(0o600);
      expect(await fileMode(path.join(stepLogDir, "reconcile.md"))).toBe(0o600);
    } finally {
      await removeDir(project.directory);
    }
  });

  test("passes dangerous OpenCode permission bypass only when configured", async () => {
    const project = await setupRunnerProject("success");
    try {
      const argsFile = path.join(project.context.paths.logs, "args.json");
      process.env.ROADRUNNER_FAKE_OPENCODE_ARGS_FILE = argsFile;
      project.context.config.dangerouslySkipPermissions = true;

      expect(await runRoadrunner(project.context, { maxSteps: 1 })).toBe(1);
      expect(JSON.parse(await readFile(argsFile, "utf8"))).toContain("--dangerously-skip-permissions");
    } finally {
      await removeDir(project.directory);
    }
  });

  test("caps provider timeout with the default when maxHours is longer", async () => {
    const project = await setupRunnerProject("success");
    try {
      const envFile = path.join(project.context.paths.logs, "env.json");
      delete process.env.ROADRUNNER_PROVIDER_TIMEOUT_MS;
      process.env.ROADRUNNER_FAKE_OPENCODE_ENV_FILE = envFile;

      expect(await runRoadrunner(project.context, { maxHours: 1, maxSteps: 1 })).toBe(1);
      expect(JSON.parse(await readFile(envFile, "utf8"))).toEqual({ ROADRUNNER_PROVIDER_TIMEOUT_MS: "1800000" });
    } finally {
      await removeDir(project.directory);
    }
  });

  test("uses remaining maxHours deadline when provider timeout is disabled", async () => {
    const project = await setupRunnerProject("success");
    try {
      const envFile = path.join(project.context.paths.logs, "env-disabled.json");
      process.env.ROADRUNNER_PROVIDER_TIMEOUT_MS = "0";
      process.env.ROADRUNNER_FAKE_OPENCODE_ENV_FILE = envFile;

      expect(await runRoadrunner(project.context, { maxHours: 0.001, maxSteps: 1 })).toBe(1);
      const timeoutMs = Number(JSON.parse(await readFile(envFile, "utf8")).ROADRUNNER_PROVIDER_TIMEOUT_MS);
      expect(timeoutMs).toBeGreaterThan(0);
      expect(timeoutMs).toBeLessThanOrEqual(3600);
    } finally {
      await removeDir(project.directory);
    }
  });

  test("completes a queue-only step when verification passes", async () => {
    const project = await setupRunnerProject("noop", sampleRoadmap({ verification: 'node -e "process.exit(0)"' }));
    try {
      expect(await runRoadrunner(project.context, { maxSteps: 1 })).toBe(1);
      const queue = await readJson<QueueFile>(project.context.paths.queue);
      expect(queue.history.map((step) => step.id)).toEqual(["first-step"]);
      expect(queue.blocked).toEqual([]);
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
        "step",
        "plan",
        "provider-start",
        "implement",
        "provider-start",
        "verify",
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
      await writeJson(project.context.paths.queue, queue);

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

  test("status reads queue state without requiring goals", async () => {
    const project = await setupRunnerProject("success");
    try {
      await rm(project.context.paths.goals, { force: true });

      expect((await status(project.context)).queued).toBe(1);
    } finally {
      await removeDir(project.directory);
    }
  });

  test("run rejects missing goals before agents", async () => {
    const project = await setupRunnerProject("success");
    try {
      await rm(project.context.paths.goals, { force: true });

      await expect(runRoadrunner(project.context)).rejects.toThrow(/GOALS\.md must exist/);
    } finally {
      await removeDir(project.directory);
    }
  });

  test("run rejects empty goals before agents", async () => {
    const project = await setupRunnerProject("success");
    try {
      await writeFile(project.context.paths.goals, "\n");

      await expect(runRoadrunner(project.context)).rejects.toThrow(/GOALS\.md must not be empty/);
    } finally {
      await removeDir(project.directory);
    }
  });

  test("run rejects invalid queue state before agents", async () => {
    const project = await setupRunnerProject("success");
    try {
      await writeFile(project.context.paths.queue, `${JSON.stringify({ version: 1 }, null, 2)}\n`);

      await expect(runRoadrunner(project.context)).rejects.toThrow(/queue.version must be 2/);
    } finally {
      await removeDir(project.directory);
    }
  });

  test("allows dirty worktrees", async () => {
    const project = await setupRunnerProject("success");
    try {
      await writeFile(path.join(project.directory, "dirty.txt"), "dirty\n");

      expect(await runRoadrunner(project.context)).toBe(1);
      expect(await readFile(path.join(project.directory, "dirty.txt"), "utf8")).toBe("dirty\n");
    } finally {
      await removeDir(project.directory);
    }
  });

  test("keeps one goals snapshot for the whole run", async () => {
    const project = await setupRunnerProject("goals-snapshot");
    try {
      expect(await runRoadrunner(project.context)).toBe(1);
      expect(await readFile(path.join(project.directory, "GOALS.md"), "utf8")).toMatch(/Changed during run/);
      expect(await readFile(path.join(project.directory, "goal-snapshot.txt"), "utf8")).toBe("original\n");
    } finally {
      await removeDir(project.directory);
    }
  });

  test("allows planning agents that change files", async () => {
    const project = await setupRunnerProject("plan-dirty");
    try {
      expect(await runRoadrunner(project.context)).toBe(1);
      expect(await readFile(path.join(project.directory, "plan-dirty.txt"), "utf8")).toBe("nope\n");
    } finally {
      await removeDir(project.directory);
    }
  });

  test("allows verification commands that mutate files", async () => {
    const project = await setupRunnerProject("success", sampleRoadmap({ verification: "node -e \"require('node:fs').writeFileSync('verify-dirty.txt', 'dirty\\n')\"" }));
    try {
      expect(await runRoadrunner(project.context)).toBe(1);
      expect(await readFile(path.join(project.directory, "verify-dirty.txt"), "utf8")).toBe("dirty\n");
    } finally {
      await removeDir(project.directory);
    }
  });

  test("rejects verification commands that commit changes by failing the command", async () => {
    const verification = `node -e "const fs = require('node:fs'); const cp = require('node:child_process'); fs.writeFileSync('verify-commit.txt', 'bad\\n'); cp.execFileSync(process.env.ROADRUNNER_TEST_REAL_GIT || '/usr/bin/git', ['add', 'verify-commit.txt']); cp.execFileSync(process.env.ROADRUNNER_TEST_REAL_GIT || '/usr/bin/git', ['commit', '-m', 'Verify commit']); process.exit(3);"`;
    const project = await setupRunnerProject("success", sampleRoadmap({ verification }));
    try {
      await expect(runRoadrunner(project.context)).rejects.toThrow(/Verification failed/);
      const queue = await readJson<QueueFile>(project.context.paths.queue);
      expect(queue.blocked[0]).toMatchObject({ blockedReason: "Verification failed after fix attempt.", id: "first-step" });
      expect((await run("git", ["log", "--oneline", "--grep", "Verify commit"], project.directory)).stdout).toMatch(/Verify commit/);
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
      await writeJson(project.context.paths.queue, queue);
      await writeFile(project.context.paths.lock, `${JSON.stringify({ pid: 99999999, startedAt: new Date().toISOString() }, null, 2)}\n`);

      expect(await runRoadrunner(project.context)).toBe(0);
      expect(await pathExists(project.context.paths.lock)).toBe(false);
    } finally {
      await removeDir(project.directory);
    }
  });

  test("does not remove a replacement run lock on release", async () => {
    const project = await setupRunnerProject("success");
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
    const project = await setupRunnerProject("success");
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
    const project = await setupRunnerProject("success");
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

  test("allows implementation agents that mutate queue state", async () => {
    const project = await setupRunnerProject("queue-dirty");
    try {
      expect(await runRoadrunner(project.context)).toBe(1);
      const queue = await readJson<QueueFile>(project.context.paths.queue);
      expect(queue.history[0]).toMatchObject({ id: "first-step", title: "Implementation touched queue" });
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

  test("blocks failures using the latest valid queue state", async () => {
    const project = await setupRunnerProject("provider-fail-queue-dirty");
    try {
      await expect(runRoadrunner(project.context)).rejects.toThrow(/Implementation failed/);

      const queue = await readJson<QueueFile>(project.context.paths.queue);
      expect(queue.blocked[0]).toMatchObject({ blockedReason: "Provider exited 7", id: "first-step", title: "Provider changed title before failing" });
    } finally {
      await removeDir(project.directory);
    }
  });

  test("blocks failures using the original queue when the latest queue is invalid", async () => {
    const project = await setupRunnerProject("provider-fail-invalid-queue");
    try {
      await expect(runRoadrunner(project.context)).rejects.toThrow(/Implementation failed/);

      const queue = await readJson<QueueFile>(project.context.paths.queue);
      expect(queue.version).toBe(2);
      expect(queue.blocked[0]).toMatchObject({ blockedReason: "Provider exited 7", id: "first-step" });
    } finally {
      await removeDir(project.directory);
    }
  });

  test("blocks failures using the original queue when the current step changed", async () => {
    const project = await setupRunnerProject("provider-fail-other-current");
    try {
      await expect(runRoadrunner(project.context)).rejects.toThrow(/Implementation failed/);

      const queue = await readJson<QueueFile>(project.context.paths.queue);
      expect(queue.blocked[0]).toMatchObject({ blockedReason: "Provider exited 7", id: "first-step" });
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

  test("allows reconciliation changes outside the queue", async () => {
    const project = await setupRunnerProject("reconcile-extra");
    try {
      expect(await runRoadrunner(project.context)).toBe(1);
      expect(await readFile(path.join(project.directory, "unexpected.txt"), "utf8")).toBe("nope\n");
    } finally {
      await removeDir(project.directory);
    }
  });

  test("allows reconciliation commits outside Roadrunner", async () => {
    const project = await setupRunnerProject("reconcile-commit-bypass");
    try {
      expect(await runRoadrunner(project.context)).toBe(1);
      expect((await run("git", ["log", "--oneline", "--grep", "Agent reconcile commit"], project.directory)).stdout).toMatch(/Agent reconcile commit/);
    } finally {
      await removeDir(project.directory);
    }
  });

  test("accepts valid queue-only reconciliation changes", async () => {
    const project = await setupRunnerProject("reconcile-queue");
    try {
      expect(await runRoadrunner(project.context)).toBe(1);
      const queue = await readJson<QueueFile>(project.context.paths.queue);

      expect(queue.history[0]).toMatchObject({ id: "first-step", title: "Reconciled first step" });
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
      await expect(runRoadrunner(project.context)).rejects.toThrow(/Reconciliation failed/);
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

async function fileMode(filePath: string): Promise<number> {
  return (await stat(filePath)).mode & 0o777;
}

async function logDirFor(context: ProjectContext, suffix: string): Promise<string> {
  const entries = await readdir(context.paths.logs);
  const entry = entries.find((value) => value.endsWith(`-${suffix}`));
  if (!entry) throw new Error(`Missing log dir for ${suffix}.`);
  return path.join(context.paths.logs, entry);
}
