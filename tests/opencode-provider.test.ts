import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, describe, expect, test } from "vitest";

import { defaultModel, defaultVariant, loadContext } from "../src/config.js";
import { OpenCodeProvider } from "../src/providers/opencode.js";
import { createFakeOpenCodeBin, removeDir, tempDir, withPath } from "./helpers.js";

const oldEnv = { ...process.env };

afterEach(() => {
  process.env = { ...oldEnv };
});

describe("OpenCodeProvider", () => {
  test("runs opencode with model, variant, agent, prompt, and logs output", async () => {
    const directory = await tempDir("roadrunner-provider-");
    try {
      const binDir = await createFakeOpenCodeBin(directory);
      const argsFile = path.join(directory, "args.json");
      process.env.PATH = withPath(binDir);
      process.env.ROADRUNNER_FAKE_OPENCODE_ARGS_FILE = argsFile;
      const context = await loadContext(directory, { _: [] });
      context.config.allowNestedOpenCode = true;
      const provider = new OpenCodeProvider({ model: defaultModel, variant: defaultVariant });
      const logPath = path.join(directory, "logs/opencode.log");
      const starts: unknown[] = [];

      const result = await provider.run({ agent: "plan", context, logPath, onStart: (event) => starts.push(event), prompt: "Roadrunner Plan Step", role: "plan", skipPermissions: false });

      expect(result).toMatchObject({ code: 0 });
      expect(result.output).toMatch(/Plan:/);
      expect(await readFile(logPath, "utf8")).toBe(result.output);
      const args = JSON.parse(await readFile(argsFile, "utf8"));
      const promptFile = args[args.indexOf("--file") + 1];
      expect(args).toEqual(["run", "--model", defaultModel, "--variant", defaultVariant, "--agent", "plan", "Follow the attached Roadrunner prompt file exactly.", "--file", expect.any(String)]);
      expect(args).not.toContain("Roadrunner Plan Step");
      expect(await readFile(promptFile, "utf8")).toBe("Roadrunner Plan Step");
      expect(starts).toEqual([
        {
          command: ["opencode", "run", "--model", defaultModel, "--variant", defaultVariant, "--agent", "plan", "Follow the attached Roadrunner prompt file exactly.", "--file", "<prompt-file>"],
          debug: false,
          logPath,
          pid: expect.any(Number),
          role: "plan",
        },
      ]);
    } finally {
      await removeDir(directory);
    }
  });

  test("passes OpenCode debug flags when requested", async () => {
    const directory = await tempDir("roadrunner-provider-debug-");
    try {
      const binDir = await createFakeOpenCodeBin(directory);
      const argsFile = path.join(directory, "args.json");
      const starts: unknown[] = [];
      process.env.PATH = withPath(binDir);
      process.env.ROADRUNNER_FAKE_OPENCODE_ARGS_FILE = argsFile;
      process.env.ROADRUNNER_OPENCODE_DEBUG = "1";
      const context = await loadContext(directory, { _: [] });
      context.config.allowNestedOpenCode = true;

      await new OpenCodeProvider().run({ agent: "plan", context, logPath: path.join(directory, "debug.log"), onStart: (event) => starts.push(event), prompt: "Roadrunner Plan Step", role: "plan", skipPermissions: false });

      expect(JSON.parse(await readFile(argsFile, "utf8"))).toEqual([
        "run",
        "--model",
        defaultModel,
        "--variant",
        defaultVariant,
        "--agent",
        "plan",
        "Follow the attached Roadrunner prompt file exactly.",
        "--file",
        expect.any(String),
        "--print-logs",
        "--log-level",
        "DEBUG",
      ]);
      expect(starts).toEqual([
        expect.objectContaining({
          command: ["opencode", "run", "--model", defaultModel, "--variant", defaultVariant, "--agent", "plan", "Follow the attached Roadrunner prompt file exactly.", "--file", "<prompt-file>", "--print-logs", "--log-level", "DEBUG"],
          debug: true,
        }),
      ]);
    } finally {
      await removeDir(directory);
    }
  });

  test("runs isolated OpenCode when no nested session is present", async () => {
    const directory = await tempDir("roadrunner-provider-isolated-");
    try {
      const binDir = await createFakeOpenCodeBin(directory);
      process.env.PATH = withPath(binDir);
      for (const key of ["OPENCODE_SESSION", "OPENCODE_SESSION_ID", "OPENCODE_SERVER", "OPENCODE_WORKSPACE", "OPENCODE_APP_INFO"]) delete process.env[key];
      const context = await loadContext(directory, { _: [] });

      const result = await new OpenCodeProvider().run({ agent: "plan", context, logPath: path.join(directory, "isolated.log"), prompt: "Roadrunner Plan Step", role: "plan", skipPermissions: false });

      expect(result.code).toBe(0);
    } finally {
      await removeDir(directory);
    }
  });

  test("times out hung provider processes", async () => {
    const directory = await tempDir("roadrunner-provider-timeout-");
    try {
      const binDir = await createFakeOpenCodeBin(directory);
      process.env.PATH = withPath(binDir);
      process.env.ROADRUNNER_FAKE_OPENCODE_MODE = "hang";
      const context = await loadContext(directory, { _: [] });
      context.config.allowNestedOpenCode = true;
      const logPath = path.join(directory, "timeout.log");

      const result = await new OpenCodeProvider().run({
        agent: "plan",
        context,
        env: { ROADRUNNER_PROVIDER_TIMEOUT_MS: "50" },
        logPath,
        prompt: "Roadrunner Plan Step",
        role: "plan",
        skipPermissions: false,
      });

      expect(result.code).toBe(124);
      expect(result.output).toMatch(/hanging/);
      expect(result.output).toMatch(/Provider timed out after 50 ms/);
      expect(await readFile(logPath, "utf8")).toBe(result.output);
    } finally {
      await removeDir(directory);
    }
  });

  test("force kills provider descendants after timeout", async () => {
    const directory = await tempDir("roadrunner-provider-timeout-child-");
    let childPid: number | null = null;
    try {
      const binDir = await createFakeOpenCodeBin(directory);
      const childPidFile = path.join(directory, "child.pid");
      process.env.PATH = withPath(binDir);
      process.env.ROADRUNNER_FAKE_OPENCODE_MODE = "spawn-child-on-term";
      process.env.ROADRUNNER_FAKE_OPENCODE_CHILD_PID_FILE = childPidFile;
      const context = await loadContext(directory, { _: [] });
      context.config.allowNestedOpenCode = true;

      const result = await new OpenCodeProvider().run({
        agent: "plan",
        context,
        env: { ROADRUNNER_PROVIDER_TIMEOUT_MS: "50" },
        logPath: path.join(directory, "timeout-child.log"),
        prompt: "Roadrunner Plan Step",
        role: "plan",
        skipPermissions: false,
      });
      childPid = Number(await readFile(childPidFile, "utf8"));
      await sleep(50);

      expect(result.code).toBe(124);
      expect(processIsRunning(childPid)).toBe(false);
    } finally {
      if (childPid !== null) killIfRunning(childPid);
      await removeDir(directory);
    }
  });

  test("rejects invalid provider timeout values", async () => {
    const directory = await tempDir("roadrunner-provider-timeout-invalid-");
    try {
      const binDir = await createFakeOpenCodeBin(directory);
      process.env.PATH = withPath(binDir);
      const context = await loadContext(directory, { _: [] });
      context.config.allowNestedOpenCode = true;

      await expect(
        new OpenCodeProvider().run({
          agent: "plan",
          context,
          env: { ROADRUNNER_PROVIDER_TIMEOUT_MS: "nope" },
          logPath: path.join(directory, "timeout-invalid.log"),
          prompt: "Roadrunner Plan Step",
          role: "plan",
          skipPermissions: false,
        }),
      ).rejects.toThrow(/ROADRUNNER_PROVIDER_TIMEOUT_MS/);
    } finally {
      await removeDir(directory);
    }
  });

  test("adds skip-permissions flag by default", async () => {
    const directory = await tempDir("roadrunner-provider-skip-");
    try {
      const binDir = await createFakeOpenCodeBin(directory);
      const argsFile = path.join(directory, "args.json");
      process.env.PATH = withPath(binDir);
      process.env.ROADRUNNER_FAKE_OPENCODE_ARGS_FILE = argsFile;
      const context = await loadContext(directory, { _: [] });
      context.config.allowNestedOpenCode = true;

      await new OpenCodeProvider().run({ agent: "build", context, logPath: path.join(directory, "log.txt"), prompt: "Roadrunner Implement Step", role: "build" });

      expect(JSON.parse(await readFile(argsFile, "utf8"))).toContain("--dangerously-skip-permissions");
    } finally {
      await removeDir(directory);
    }
  });

  test("returns code 1 when opencode cannot spawn", async () => {
    const directory = await tempDir("roadrunner-provider-error-");
    try {
      process.env.PATH = directory;
      const context = await loadContext(directory, { _: [] });
      context.config.allowNestedOpenCode = true;
      const starts: unknown[] = [];

      const result = await new OpenCodeProvider().run({ agent: "plan", context, logPath: path.join(directory, "log.txt"), onStart: (event) => starts.push(event), prompt: "prompt", role: "plan" });

      expect(result.code).toBe(1);
      expect(result.output).toMatch(/ENOENT/);
      expect(await readFile(path.join(directory, "log.txt"), "utf8")).toBe(result.output);
      expect(starts).toEqual([expect.objectContaining({ pid: null })]);
    } finally {
      await removeDir(directory);
    }
  });

  test("returns code 1 when process registration fails after spawn", async () => {
    const directory = await tempDir("roadrunner-provider-register-error-");
    try {
      const binDir = await createFakeOpenCodeBin(directory);
      await writeFile(path.join(directory, "registry-parent"), "not a directory\n");
      process.env.PATH = withPath(binDir);
      process.env.ROADRUNNER_FAKE_OPENCODE_MODE = "hang";
      const context = await loadContext(directory, { _: [], processes: "registry-parent/processes.json" });
      context.config.allowNestedOpenCode = true;

      const result = await new OpenCodeProvider().run({ agent: "plan", context, logPath: path.join(directory, "register.log"), prompt: "Roadrunner Plan Step", role: "plan", skipPermissions: false });

      expect(result.code).toBe(1);
      expect(result.output).toMatch(/Failed to register provider process/);
    } finally {
      await removeDir(directory);
    }
  });

  test("blocks nested OpenCode unless explicitly allowed", async () => {
    const directory = await tempDir("roadrunner-provider-nested-");
    try {
      await mkdir(directory, { recursive: true });
      const context = await loadContext(directory, { _: [] });
      process.env.OPENCODE_SESSION = "nested";

      await expect(new OpenCodeProvider().run({ agent: "plan", context, logPath: path.join(directory, "log.txt"), prompt: "prompt", role: "plan" })).rejects.toThrow(
        /Refusing to launch nested OpenCode/,
      );

      context.config.allowNestedOpenCode = true;
      process.env.PATH = directory;
      const result = await new OpenCodeProvider().run({ agent: "plan", context, logPath: path.join(directory, "allowed.log"), prompt: "prompt", role: "plan" });
      expect(result.code).toBe(1);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });
});

function processIsRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function killIfRunning(pid: number): void {
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // Best-effort cleanup for failed timeout assertions.
  }
}
