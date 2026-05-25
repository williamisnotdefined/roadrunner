import { mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
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
      expect(JSON.parse(await readFile(argsFile, "utf8"))).toEqual(["run", "--model", defaultModel, "--variant", defaultVariant, "--agent", "plan", "Roadrunner Plan Step"]);
      expect(starts).toEqual([
        {
          command: ["opencode", "run", "--model", defaultModel, "--variant", defaultVariant, "--agent", "plan", "<prompt>"],
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
        "--print-logs",
        "--log-level",
        "DEBUG",
        "Roadrunner Plan Step",
      ]);
      expect(starts).toEqual([
        expect.objectContaining({
          command: ["opencode", "run", "--model", defaultModel, "--variant", defaultVariant, "--agent", "plan", "--print-logs", "--log-level", "DEBUG", "<prompt>"],
          debug: true,
        }),
      ]);
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
