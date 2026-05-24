import { mkdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
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

      const result = await provider.run({ agent: "plan", context, logPath, prompt: "Roadrunner Plan Step", role: "plan", skipPermissions: false });

      expect(result).toMatchObject({ code: 0 });
      expect(result.output).toMatch(/Plan:/);
      expect(await readFile(logPath, "utf8")).toBe(result.output);
      expect(JSON.parse(await readFile(argsFile, "utf8"))).toEqual(["run", "--model", defaultModel, "--variant", defaultVariant, "--agent", "plan", "Roadrunner Plan Step"]);
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

      const result = await new OpenCodeProvider().run({ agent: "plan", context, logPath: path.join(directory, "log.txt"), prompt: "prompt", role: "plan" });

      expect(result.code).toBe(1);
      expect(result.output).toMatch(/ENOENT/);
      expect(await readFile(path.join(directory, "log.txt"), "utf8")).toBe(result.output);
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

      await expect(
        new OpenCodeProvider().run({ agent: "plan", context, logPath: path.join(directory, "log.txt"), prompt: "prompt", role: "plan" }),
      ).rejects.toThrow(/Refusing to launch nested OpenCode/);

      context.config.allowNestedOpenCode = true;
      process.env.PATH = directory;
      const result = await new OpenCodeProvider().run({ agent: "plan", context, logPath: path.join(directory, "allowed.log"), prompt: "prompt", role: "plan" });
      expect(result.code).toBe(1);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });
});
