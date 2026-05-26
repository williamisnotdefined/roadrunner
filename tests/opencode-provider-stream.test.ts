import { readFile } from "node:fs/promises";
import path from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";

import { loadContext } from "../src/infrastructure/config.js";
import { OpenCodeProvider } from "../src/infrastructure/providers/opencode.js";
import { createFakeOpenCodeBin, removeDir, tempDir } from "./helpers.js";

const oldEnv = { ...process.env };

afterEach(() => {
  process.env = { ...oldEnv };
});

describe("OpenCodeProvider output streaming", () => {
  test("can suppress terminal output while preserving logs", async () => {
    const directory = await tempDir("roadrunner-provider-quiet-");
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const binDir = await createFakeOpenCodeBin(directory);
      process.env.PATH = `${binDir}${path.delimiter}${oldEnv.PATH ?? ""}`;
      const context = await loadContext(directory, { _: [] });
      context.config.allowNestedOpenCode = true;
      const logPath = path.join(directory, "logs/opencode.log");

      const result = await new OpenCodeProvider().run({
        agent: "plan",
        context,
        logPath,
        prompt: "Roadrunner Plan Step",
        role: "plan",
        streamOutput: false,
        workspaceAccess: "read-only",
      });

      expect(result.output).toMatch(/Plan:/);
      expect(await readFile(logPath, "utf8")).toBe(result.output);
      expect(stdout).not.toHaveBeenCalled();
      expect(stderr).not.toHaveBeenCalled();
    } finally {
      stdout.mockRestore();
      stderr.mockRestore();
      await removeDir(directory);
    }
  });
});
