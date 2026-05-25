import { readFile, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, test } from "vitest";

import { formatRunEvent, helpText, isCliEntrypoint, main } from "../src/cli.js";
import { readJson, writeJson } from "../src/config.js";
import { formatDuration } from "../src/duration.js";
import type { QueueFile, QueueStep } from "../src/queue.js";
import { formatRunProgress } from "../src/run-progress.js";
import { createInitializedProject, removeDir, sampleRoadmap, tempDir } from "./helpers.js";
import { createFakeOpenCodeBin, withPath } from "./helpers.js";

describe("cli", () => {
  test("recognizes symlinked package bin as entrypoint", async () => {
    const directory = await tempDir("roadrunner-cli-entrypoint-");
    try {
      const target = path.join(directory, "cli.js");
      const linkedBin = path.join(directory, "roadrunner");
      await writeFile(target, "#!/usr/bin/env node\n");
      await symlink(target, linkedBin);

      expect(isCliEntrypoint(pathToFileURL(target).href, linkedBin)).toBe(true);
      expect(isCliEntrypoint(pathToFileURL(target).href, path.join(directory, "other"))).toBe(false);
    } finally {
      await removeDir(directory);
    }
  });

  test("formats run progress events", () => {
    const step: QueueStep = {
      acceptance: ["works"],
      id: "sample-step",
      phase: "Sample",
      prompt: "Build it.",
      scope: ["src/sample.ts"],
      title: "Ship Sample",
      verification: ["npm test"],
    };

    const output = [
      formatRunEvent({ type: "validate" }),
      formatRunEvent({ type: "startup-refresh" }),
      formatRunEvent({ step, type: "step" }),
      formatRunEvent({ step, type: "plan" }),
      formatRunEvent({ command: ["opencode", "run", "<prompt>"], debug: true, logPath: "/tmp/plan.log", pid: 123, role: "plan", step, type: "provider-start" }),
      formatRunEvent({ command: ["opencode", "run", "<prompt>"], debug: false, logPath: "/tmp/missing.log", pid: null, role: "plan", step, type: "provider-start" }),
      formatRunEvent({ step, type: "implement" }),
      formatRunEvent({ elapsedMs: 123_000, phase: "implement", step, type: "task-restart-requested" }),
      formatRunEvent({ idleMs: 600_000, maxRestarts: 3, phase: "implement", restart: 2, step, type: "task-auto-restart-requested" }),
      formatRunEvent({ idleMs: 600_000, maxRestarts: 3, phase: "plan", step, type: "task-auto-restart-limit-exceeded" }),
      formatRunEvent({ attempt: 2, step, type: "task-restart" }),
      formatRunEvent({ attempt: "initial", step, type: "verify" }),
      formatRunEvent({ step, type: "fix" }),
      formatRunEvent({ attempt: "fixed", step, type: "verify" }),
      formatRunEvent({ step, type: "reconcile" }),
      formatRunEvent({ step, type: "step-complete" }),
      formatRunEvent({ type: "cleanup" }),
    ].join("\n");

    expect(output).toMatch(/Validating project/);
    expect(output).toMatch(/Refreshed queue from roadmap and repository state/);
    expect(output).toMatch(/Selected step sample-step: Ship Sample/);
    expect(output).toMatch(/OpenCode plan started pid=123 log=\/tmp\/plan\.log debug=on/);
    expect(output).toMatch(/OpenCode plan started pid=n\/a log=\/tmp\/missing\.log/);
    expect(output).toMatch(/Restart requested for sample-step during implement after 2m03s/);
    expect(output).toMatch(/Auto-restart requested for sample-step during implement after idle=10m00s restart=2\/3/);
    expect(output).toMatch(/Auto-restart limit exceeded for sample-step during plan after idle=10m00s max=3/);
    expect(output).toMatch(/Restarting sample-step attempt=2/);
    expect(output).toMatch(/Reconciling and optimizing queue after sample-step/);
    expect(output).toMatch(/Re-running verification for sample-step/);
    expect(output).toMatch(/Completed sample-step/);
    expect(output).toMatch(/Cleaning Roadrunner-owned processes/);
  });

  test("formats run heartbeat durations", () => {
    expect(formatDuration(999)).toBe("0s");
    expect(formatDuration(65_000)).toBe("1m05s");
    expect(formatDuration(3_661_000)).toBe("1h01m01s");

    expect(
      formatRunProgress(
        {
          attempt: 2,
          lastActivityAt: 60_000,
          logPath: "/tmp/implement.log",
          phase: "implement",
          phaseStartedAt: 10_000,
          pid: 123,
          stepId: "sample-step",
          taskStartedAt: 0,
        },
        70_000,
      ),
    ).toContain("implement sample-step attempt=2 elapsed=1m10s phase=1m00s idle=10s pid=123 log=/tmp/implement.log");
  });

  test("prints help for default command", async () => {
    const directory = await tempDir("roadrunner-cli-help-");
    const output: string[] = [];
    try {
      expect(helpText()).toMatch(/import-roadmap/);
      expect(await main([], { cwd: directory, io: { stdout: (message) => output.push(message) } })).toBe(0);
      expect(output.join("\n")).toMatch(/Roadrunner/);
    } finally {
      await removeDir(directory);
    }
  });

  test("prints help without loading broken project config", async () => {
    const directory = await tempDir("roadrunner-cli-help-broken-config-");
    const output: string[] = [];
    try {
      await writeFile(path.join(directory, "roadrunner.config.json"), "not json\n");

      expect(await main([], { cwd: directory, io: { stdout: (message) => output.push(message) } })).toBe(0);
      expect(output.join("\n")).toMatch(/Roadrunner/);
    } finally {
      await removeDir(directory);
    }
  });

  test("runs init, check, status, next, import-roadmap, and cleanup commands", async () => {
    const directory = await tempDir("roadrunner-cli-project-");
    const output: string[] = [];
    const io = { stderr: (message: string) => output.push(`ERR:${message}`), stdout: (message: string) => output.push(message) };
    const originalPath = process.env.PATH;
    try {
      const binDir = await createFakeOpenCodeBin(directory);
      process.env.PATH = withPath(binDir);
      await writeFile(path.join(directory, "ROADMAP.md"), sampleRoadmap());

      expect(await main(["init"], { cwd: directory, io })).toBe(0);
      expect(await main(["check"], { cwd: directory, io })).toBe(0);
      expect(await main(["status"], { cwd: directory, io })).toBe(0);
      expect(await main(["next"], { cwd: directory, io })).toBe(0);
      expect(await main(["import-roadmap"], { cwd: directory, io })).toBe(0);
      expect(await main(["cleanup"], { cwd: directory, io })).toBe(0);

      expect(output.join("\n")).toMatch(/Roadrunner initialized/);
      expect(output.join("\n")).toMatch(/Roadrunner project is valid/);
      expect(output.join("\n")).toMatch(/queued: 1/);
      expect(output.join("\n")).toMatch(/first-step - Build first step/);
      expect(output.join("\n")).toMatch(/No Roadrunner-owned processes/);
    } finally {
      process.env.PATH = originalPath;
      await removeDir(directory);
    }
  });

  test("check reports missing provider tooling for otherwise valid projects", async () => {
    const directory = await tempDir("roadrunner-cli-check-provider-error-");
    const errors: string[] = [];
    const originalPath = process.env.PATH;
    try {
      await createInitializedProject(directory);
      process.env.PATH = directory;

      expect(await main(["check"], { cwd: directory, io: { stderr: (message) => errors.push(message) } })).toBe(1);
      expect(errors.join("\n")).toMatch(/opencode must be installed/);
    } finally {
      process.env.PATH = originalPath;
      await removeDir(directory);
    }
  });

  test("reports queue validation errors in check", async () => {
    const directory = await tempDir("roadrunner-cli-check-error-");
    const errors: string[] = [];
    try {
      const context = await createInitializedProject(directory);
      await writeFile(context.paths.queue, `${JSON.stringify({ version: 1 }, null, 2)}\n`);

      expect(await main(["check"], { cwd: directory, io: { stderr: (message) => errors.push(message) } })).toBe(1);
      expect(errors.join("\n")).toMatch(/queue.version must be 2/);
    } finally {
      await removeDir(directory);
    }
  });

  test("reports queue validation errors in next", async () => {
    const directory = await tempDir("roadrunner-cli-next-error-");
    const errors: string[] = [];
    try {
      const context = await createInitializedProject(directory);
      await writeFile(context.paths.queue, `${JSON.stringify({ version: 1 }, null, 2)}\n`);

      expect(await main(["next"], { cwd: directory, io: { stderr: (message) => errors.push(message) } })).toBe(1);
      expect(errors.join("\n")).toMatch(/queue.version must be 2/);
    } finally {
      await removeDir(directory);
    }
  });

  test("prints cleanup records", async () => {
    const directory = await tempDir("roadrunner-cli-cleanup-");
    const output: string[] = [];
    try {
      const context = await createInitializedProject(directory);
      await writeJson(context.paths.processRegistry, { processes: [{ command: ["missing"], cwd: directory, pid: 99999999, role: "old", startTimeTicks: "old" }] });

      expect(await main(["cleanup"], { cwd: directory, io: { stdout: (message) => output.push(message) } })).toBe(0);
      expect(await main(["cleanup", "--force"], { cwd: directory, io: { stdout: (message) => output.push(message) } })).toBe(0);
      expect(output).toContain("stale: pid=99999999 role=old");
    } finally {
      await removeDir(directory);
    }
  });

  test("prints no queued step for plan when queue is empty", async () => {
    const directory = await tempDir("roadrunner-cli-plan-");
    const output: string[] = [];
    try {
      const context = await createInitializedProject(directory);
      const queue = await readJson<QueueFile>(context.paths.queue);
      queue.queue = [];
      await writeJson(context.paths.queue, queue);

      expect(await main(["plan"], { cwd: directory, io: { stdout: (message) => output.push(message) } })).toBe(0);
      expect(output.join("\n")).toMatch(/No queued step/);
    } finally {
      await removeDir(directory);
    }
  });

  test("prints plan log path for queued plan", async () => {
    const directory = await tempDir("roadrunner-cli-plan-success-");
    const output: string[] = [];
    const originalPath = process.env.PATH;
    try {
      const binDir = await createFakeOpenCodeBin(directory);
      process.env.PATH = withPath(binDir);
      const context = await createInitializedProject(directory);
      context.config.allowNestedOpenCode = true;

      expect(await main(["plan"], { cwd: directory, io: { stdout: (message) => output.push(message) } })).toBe(0);
      expect(output.join("\n")).toMatch(/Plan written to/);
    } finally {
      process.env.PATH = originalPath;
      await removeDir(directory);
    }
  });

  test("returns an error when queued planning fails", async () => {
    const directory = await tempDir("roadrunner-cli-plan-fail-");
    const errors: string[] = [];
    const originalEnv = { ...process.env };
    try {
      const binDir = await createFakeOpenCodeBin(directory);
      process.env.PATH = withPath(binDir);
      process.env.ROADRUNNER_FAKE_OPENCODE_MODE = "plan-fail";
      await createInitializedProject(directory);

      expect(await main(["plan"], { cwd: directory, io: { stderr: (message) => errors.push(message) } })).toBe(1);
      expect(errors.join("\n")).toMatch(/Planning failed/);
    } finally {
      process.env = originalEnv;
      await removeDir(directory);
    }
  });

  test("run command launches the terminal UI with parsed limits", async () => {
    const directory = await tempDir("roadrunner-cli-run-tui-");
    let seen: { maxHours?: number; maxSteps?: number } | null = null;
    try {
      await createInitializedProject(directory);

      expect(
        await main(["run", "--max-steps", "2", "--max-hours", "3"], {
          cwd: directory,
          runTui: async (_context, options) => {
            seen = { maxHours: options.maxHours, maxSteps: options.maxSteps };
            return 0;
          },
          terminal: { isInteractive: true },
        }),
      ).toBe(0);
      expect(seen).toEqual({ maxHours: 3, maxSteps: 2 });
    } finally {
      await removeDir(directory);
    }
  });

  test("returns errors without throwing", async () => {
    const directory = await tempDir("roadrunner-cli-error-");
    const errors: string[] = [];
    try {
      expect(await main(["run", "--max-hours"], { cwd: directory, io: { stderr: (message) => errors.push(message) } })).toBe(1);
      expect(errors.join("\n")).toMatch(/Expected a value for --max-hours/);

      expect(await main(["check"], { cwd: directory, io: { stderr: (message) => errors.push(message) } })).toBe(1);
      expect(errors.join("\n")).toMatch(/ENOENT|no such file/i);
    } finally {
      await removeDir(directory);
    }
  });

  test("uses default stderr when no error io is provided", async () => {
    const directory = await tempDir("roadrunner-cli-default-error-");
    const originalError = console.error;
    const errors: string[] = [];
    try {
      console.error = (message?: unknown) => {
        errors.push(String(message));
      };

      expect(await main(["check"], { cwd: directory })).toBe(1);
      expect(errors.join("\n")).toMatch(/ENOENT|no such file/i);
    } finally {
      console.error = originalError;
      await removeDir(directory);
    }
  });

  test("run command requires an interactive terminal", async () => {
    const directory = await tempDir("roadrunner-cli-run-nontty-");
    const errors: string[] = [];
    try {
      await createInitializedProject(directory);

      expect(await main(["run", "--max-steps", "1"], { cwd: directory, io: { stderr: (message) => errors.push(message) }, terminal: { isInteractive: false } })).toBe(1);
      expect(errors.join("\n")).toMatch(/requires an interactive terminal/);
    } finally {
      await removeDir(directory);
    }
  });

  test("reads roadmap path override", async () => {
    const directory = await tempDir("roadrunner-cli-roadmap-");
    try {
      await writeFile(path.join(directory, "CUSTOM.md"), sampleRoadmap());
      expect(await main(["init", "--roadmap", "CUSTOM.md"], { cwd: directory })).toBe(0);
      expect(await readFile(path.join(directory, ".roadrunner/queue.json"), "utf8")).toMatch(/first-step/);
    } finally {
      await removeDir(directory);
    }
  });
});
