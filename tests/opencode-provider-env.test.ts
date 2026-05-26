import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import { loadContext, pathExists } from "../src/infrastructure/config.js";
import { OpenCodeProvider } from "../src/infrastructure/providers/opencode.js";
import { createFakeOpenCodeBin, removeDir, tempDir, withPath } from "./helpers.js";

const oldEnv = { ...process.env };

afterEach(() => {
  process.env = { ...oldEnv };
});

describe("OpenCodeProvider environment and output capture", () => {
  test("passes only allowed Roadrunner environment variables to providers", async () => {
    const directory = await tempDir("roadrunner-provider-env-allowlist-");
    try {
      const binDir = await createFakeOpenCodeBin(directory);
      const envFile = path.join(directory, "env.json");
      process.env.PATH = withPath(binDir);
      process.env.ROADRUNNER_FAKE_OPENCODE_ENV_FILE = envFile;
      process.env.ROADRUNNER_PROVIDER_TIMEOUT_MS = "12345";
      process.env.ROADRUNNER_SECRET = "secret";
      const context = await loadContext(directory, { _: [] });
      context.config.allowNestedOpenCode = true;

      const result = await new OpenCodeProvider().run({ agent: "plan", context, logPath: path.join(directory, "env.log"), prompt: "Roadrunner Plan Step", role: "plan", workspaceAccess: "read-only" });

      expect(result.code).toBe(0);
      expect(JSON.parse(await readFile(envFile, "utf8"))).toMatchObject({ ROADRUNNER_PROVIDER_TIMEOUT_MS: "12345", ROADRUNNER_SECRET: null });
    } finally {
      await removeDir(directory);
    }
  });

  test("caps captured provider output while preserving full logs", async () => {
    const directory = await tempDir("roadrunner-provider-output-cap-");
    try {
      const binDir = await createFakeOpenCodeBin(directory);
      process.env.PATH = withPath(binDir);
      process.env.ROADRUNNER_FAKE_OPENCODE_MODE = "large-output";
      process.env.ROADRUNNER_MAX_CAPTURED_OUTPUT_BYTES = "20";
      const context = await loadContext(directory, { _: [] });
      context.config.allowNestedOpenCode = true;
      const logPath = path.join(directory, "large.log");

      const result = await new OpenCodeProvider().run({ agent: "plan", context, logPath, prompt: "Roadrunner Plan Step", role: "plan", workspaceAccess: "read-only" });

      expect(result.output).toContain("Output truncated to last 20 bytes");
      expect(result.output.endsWith("b".repeat(20))).toBe(true);
      expect(await readFile(logPath, "utf8")).toBe("b".repeat(100));
    } finally {
      await removeDir(directory);
    }
  });

  test("rejects invalid output caps before starting providers", async () => {
    const directory = await tempDir("roadrunner-provider-invalid-cap-");
    try {
      const binDir = await createFakeOpenCodeBin(directory);
      const argsFile = path.join(directory, "args.json");
      process.env.PATH = withPath(binDir);
      process.env.ROADRUNNER_FAKE_OPENCODE_ARGS_FILE = argsFile;
      const context = await loadContext(directory, { _: [] });
      context.config.allowNestedOpenCode = true;

      await expect(new OpenCodeProvider().run({ agent: "plan", context, env: { ROADRUNNER_MAX_CAPTURED_OUTPUT_BYTES: "0" }, logPath: path.join(directory, "invalid-cap.log"), prompt: "Roadrunner Plan Step", role: "plan", workspaceAccess: "read-only" })).rejects.toThrow(/ROADRUNNER_MAX_CAPTURED_OUTPUT_BYTES/);
      expect(await pathExists(argsFile)).toBe(false);
    } finally {
      await removeDir(directory);
    }
  });
});
