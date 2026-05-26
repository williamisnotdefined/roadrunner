import { mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import { loadContext } from "../src/infrastructure/config.js";
import { OpenCodeProvider } from "../src/infrastructure/providers/opencode.js";
import { createFakeOpenCodeBin, tempDir, withPath } from "./helpers.js";

const oldEnv = { ...process.env };

afterEach(() => {
  process.env = { ...oldEnv };
});

describe("OpenCodeProvider nested sessions", () => {
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

  test("strips parent OpenCode session environment from allowed nested runs", async () => {
    const directory = await tempDir("roadrunner-provider-nested-env-");
    try {
      const binDir = await createFakeOpenCodeBin(directory);
      const envFile = path.join(directory, "nested-env.json");
      process.env.PATH = withPath(binDir);
      process.env.OPENCODE_SESSION = "parent-session";
      process.env.OPENCODE_SERVER = "http://127.0.0.1:4096";
      process.env.ROADRUNNER_FAKE_OPENCODE_NESTED_ENV_FILE = envFile;
      const context = await loadContext(directory, { _: [] });
      context.config.allowNestedOpenCode = true;

      const result = await new OpenCodeProvider().run({ agent: "plan", context, logPath: path.join(directory, "nested-env.log"), prompt: "Roadrunner Plan Step", role: "plan" });

      expect(result.code).toBe(0);
      expect(JSON.parse(await readFile(envFile, "utf8"))).toEqual({ OPENCODE_SESSION: null, OPENCODE_SERVER: null });
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });
});
