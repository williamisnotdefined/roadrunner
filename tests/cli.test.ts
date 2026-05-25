import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, test } from "vitest";

import { formatRunEvent, helpText, main } from "../src/cli.js";
import { readJson, writeJson } from "../src/config.js";
import type { QueueFile, QueueStep } from "../src/queue.js";
import { createInitializedProject, removeDir, sampleRoadmap, tempDir } from "./helpers.js";
import { createFakeOpenCodeBin, withPath } from "./helpers.js";

describe("cli", () => {
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
      formatRunEvent({ step, type: "step" }),
      formatRunEvent({ step, type: "plan" }),
      formatRunEvent({ command: ["opencode", "run", "<prompt>"], debug: true, logPath: "/tmp/plan.log", pid: 123, role: "plan", step, type: "provider-start" }),
      formatRunEvent({ command: ["opencode", "run", "<prompt>"], debug: false, logPath: "/tmp/missing.log", pid: null, role: "plan", step, type: "provider-start" }),
      formatRunEvent({ step, type: "implement" }),
      formatRunEvent({ attempt: "initial", step, type: "verify" }),
      formatRunEvent({ step, type: "fix" }),
      formatRunEvent({ attempt: "fixed", step, type: "verify" }),
      formatRunEvent({ step, type: "reconcile" }),
      formatRunEvent({ step, type: "step-complete" }),
      formatRunEvent({ type: "cleanup" }),
    ].join("\n");

    expect(output).toMatch(/Validating project/);
    expect(output).toMatch(/Selected step sample-step: Ship Sample/);
    expect(output).toMatch(/OpenCode plan started pid=123 log=\/tmp\/plan\.log debug=on/);
    expect(output).toMatch(/OpenCode plan started pid=n\/a log=\/tmp\/missing\.log/);
    expect(output).toMatch(/Re-running verification for sample-step/);
    expect(output).toMatch(/Completed sample-step/);
    expect(output).toMatch(/Cleaning Roadrunner-owned processes/);
  });

  test("prints help for default and unknown commands", async () => {
    const directory = await tempDir("roadrunner-cli-help-");
    const output: string[] = [];
    try {
      expect(helpText()).toMatch(/import-roadmap/);
      expect(await main([], { cwd: directory, io: { stdout: (message) => output.push(message) } })).toBe(0);
      expect(await main(["unknown"], { cwd: directory, io: { stdout: (message) => output.push(message) } })).toBe(0);
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
      expect(await main(["unknown"], { cwd: directory, io: { stdout: (message) => output.push(message) } })).toBe(0);
      expect(output.join("\n")).toMatch(/Roadrunner/);
    } finally {
      await removeDir(directory);
    }
  });

  test("runs init, check, status, next, import-roadmap, and cleanup commands", async () => {
    const directory = await tempDir("roadrunner-cli-project-");
    const output: string[] = [];
    const io = { stderr: (message: string) => output.push(`ERR:${message}`), stdout: (message: string) => output.push(message) };
    try {
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

  test("run command reports zero completed steps for a clean empty queue", async () => {
    const directory = await tempDir("roadrunner-cli-run-empty-");
    const output: string[] = [];
    try {
      const context = await createInitializedProject(directory);
      const queue = await readJson<QueueFile>(context.paths.queue);
      queue.queue = [];
      await writeFile(context.paths.queue, `${JSON.stringify(queue, null, 2)}\n`);

      expect(await main(["run", "--max-steps", "1"], { cwd: directory, io: { stdout: (message) => output.push(message) } })).toBe(0);
      expect(output.join("\n")).toMatch(/Completed 0 step\(s\)/);
    } finally {
      await removeDir(directory);
    }
  });

  test("returns errors without throwing", async () => {
    const directory = await tempDir("roadrunner-cli-error-");
    const errors: string[] = [];
    try {
      expect(await main(["run", "--max-hours"], { cwd: directory, io: { stderr: (message) => errors.push(message) } })).toBe(1);
      expect(errors.join("\n")).toMatch(/got true/);

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

  test("run command reports empty queue without git clean checks", async () => {
    const directory = await tempDir("roadrunner-cli-run-");
    const output: string[] = [];
    try {
      const context = await createInitializedProject(directory);
      const queue = await readJson<QueueFile>(context.paths.queue);
      queue.queue = [];
      await writeFile(context.paths.queue, `${JSON.stringify(queue, null, 2)}\n`);

      expect(await main(["run", "--max-steps", "1"], { cwd: directory, io: { stdout: (message) => output.push(message) } })).toBe(0);
      expect(output.join("\n")).toMatch(/Running Roadrunner/);
      expect(output.join("\n")).toMatch(/Completed 0 step\(s\)/);
      expect(output.join("\n")).not.toMatch(/clean git worktree/);
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
