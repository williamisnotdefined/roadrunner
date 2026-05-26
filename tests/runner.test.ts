import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import { writeJson } from "../src/infrastructure/config.js";
import { plan, run as runRoadrunner, status, verify, type RoadrunnerRunControl, type RoadrunnerRunEvent } from "../src/application/runner.js";
import { removeDir, run, sampleRoadmap } from "./helpers.js";
import { fileMode, latestQueueSnapshot, logDirFor, setupRunnerProject } from "./runner-helpers.js";

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
});

describe("runner", () => {
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
      await rm(project.context.paths.roadmap, { force: true });

      expect(await plan(project.context)).toBeNull();
    } finally {
      await removeDir(project.directory);
    }
  });

  test("verifies commands and returns output", async () => {
    const project = await setupRunnerProject("success");
    try {
      const step = (await status(project.context)).next!;
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
    const events: RoadrunnerRunEvent[] = [];
    try {
      process.env.ROADRUNNER_PROVIDER_TIMEOUT_MS = "100000";
      process.env.ROADRUNNER_VERIFY_TIMEOUT_MS = "0";
      const completed = await runRoadrunner(project.context, { maxHours: 1, maxSteps: 1, onEvent: (event) => events.push(event) });
      const queue = latestQueueSnapshot(events);
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
    const events: RoadrunnerRunEvent[] = [];
    try {
      project.context.config.dangerouslySkipPermissions = true;

      expect(await runRoadrunner(project.context, { maxSteps: 1, onEvent: (event) => events.push(event) })).toBe(1);
      const implementStart = events.find((event): event is Extract<RoadrunnerRunEvent, { type: "provider-start" }> => event.type === "provider-start" && event.role === "implement");
      expect(implementStart?.command).toContain("--dangerously-skip-permissions");
      for (const role of ["startup-refresh", "plan", "reconcile"]) {
        const event = events.find((item): item is Extract<RoadrunnerRunEvent, { type: "provider-start" }> => item.type === "provider-start" && item.role === role);
        expect(event?.command).not.toContain("--dangerously-skip-permissions");
      }
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

  test("reports run progress events", async () => {
    const project = await setupRunnerProject("success");
    const events: string[] = [];
    try {
      await runRoadrunner(project.context, { maxHours: 1, maxSteps: 1, onEvent: (event) => events.push(event.type) });

      expect(events).toEqual([
        "validate",
        "startup-refresh",
        "provider-start",
        "queue-updated",
        "step",
        "plan",
        "provider-start",
        "implement",
        "provider-start",
        "verify",
        "queue-updated",
        "step-complete",
        "reconcile",
        "provider-start",
        "queue-updated",
        "cleanup",
      ]);
    } finally {
      await removeDir(project.directory);
    }
  });

  test("restarts the current task when requested through run control", async () => {
    const project = await setupRunnerProject("success");
    const events: string[] = [];
    const runEvents: RoadrunnerRunEvent[] = [];
    let control: RoadrunnerRunControl | null = null;
    let restartRequested = false;

    try {
      const completed = await runRoadrunner(project.context, {
        maxHours: 1,
        maxSteps: 1,
        onControl: (nextControl) => {
          control = nextControl;
        },
        onEvent: (event) => {
          runEvents.push(event);
          events.push(event.type);
          if (event.type === "provider-start" && event.role === "implement" && !restartRequested) {
            restartRequested = true;
            if (!control?.restartCurrentTask()) throw new Error("Expected active task restart control.");
          }
        },
      });
      const queue = latestQueueSnapshot(runEvents);

      expect(completed).toBe(1);
      expect(restartRequested).toBe(true);
      expect(events).toContain("task-restart-requested");
      expect(events).toContain("task-restart");
      expect(queue.history.map((step) => step.id)).toEqual(["first-step"]);
      expect(queue.blocked).toEqual([]);
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

  test("status ignores stale runtime queue files", async () => {
    const project = await setupRunnerProject("success");
    try {
      await writeJson(staleQueuePath(project.directory), { version: 1 });

      expect((await status(project.context)).queued).toBe(1);
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

  test("run ignores invalid stale queue state during startup hard reset", async () => {
    const project = await setupRunnerProject("success");
    const events: RoadrunnerRunEvent[] = [];
    try {
      await writeJson(staleQueuePath(project.directory), { version: 1 });

      expect(await runRoadrunner(project.context, { onEvent: (event) => events.push(event) })).toBe(1);
      const queue = latestQueueSnapshot(events);
      expect(queue.history.map((step) => step.id)).toEqual(["first-step"]);
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
    const events: RoadrunnerRunEvent[] = [];
    try {
      await expect(runRoadrunner(project.context, { onEvent: (event) => events.push(event) })).rejects.toThrow(/Verification failed/);
      const queue = latestQueueSnapshot(events);
      expect(queue.blocked[0]).toMatchObject({ blockedReason: "Verification failed after fix attempt.", id: "first-step" });
      expect((await run("git", ["log", "--oneline", "--grep", "Verify commit"], project.directory)).stdout).toMatch(/Verify commit/);
    } finally {
      await removeDir(project.directory);
    }
  });

  test("times out verification commands", async () => {
    process.env.ROADRUNNER_VERIFY_TIMEOUT_MS = "50";
    const project = await setupRunnerProject("fix-fail", sampleRoadmap({ verification: 'node -e "Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0)"' }));
    const events: RoadrunnerRunEvent[] = [];
    try {
      await expect(runRoadrunner(project.context, { onEvent: (event) => events.push(event) })).rejects.toThrow(/Verification failed/);
      const queue = latestQueueSnapshot(events);
      expect(queue.blocked[0]).toMatchObject({ id: "first-step" });
    } finally {
      await removeDir(project.directory);
    }
  });

});

function staleQueuePath(directory: string): string {
  return path.join(directory, ".roadrunner/state/queue.json");
}
