import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, test } from "vitest";

import { loadContext } from "../src/config.js";
import { runShell } from "../src/managed-process.js";
import { removeDir, tempDir } from "./helpers.js";

describe("managed process", () => {
  test("aborts shell commands through run control", async () => {
    const directory = await tempDir("roadrunner-managed-process-abort-");
    try {
      const context = await loadContext(directory, { _: [] });
      const abortController = new AbortController();
      const script = "console.log('started'); setInterval(() => {}, 1000);";

      const result = await runShell(context, `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`, path.join(directory, "abort.log"), "verify-1", {
        onOutput: () => abortController.abort(),
        signal: abortController.signal,
      });

      expect(result.code).toBe(130);
      expect(result.output).toMatch(/started/);
      expect(result.output).toMatch(/Command aborted by Roadrunner control/);
    } finally {
      await removeDir(directory);
    }
  });

  test("aborts immediately when the signal is already aborted", async () => {
    const directory = await tempDir("roadrunner-managed-process-preabort-");
    try {
      const context = await loadContext(directory, { _: [] });
      const abortController = new AbortController();
      abortController.abort();
      const script = "setInterval(() => {}, 1000);";

      const result = await runShell(context, `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`, path.join(directory, "preabort.log"), "verify-1", {
        signal: abortController.signal,
      });

      expect(result.code).toBe(130);
      expect(result.output).toMatch(/Command aborted by Roadrunner control/);
    } finally {
      await removeDir(directory);
    }
  });

  test("returns code 1 when shell process registration fails", async () => {
    const directory = await tempDir("roadrunner-managed-process-register-error-");
    try {
      await writeFile(path.join(directory, "registry-parent"), "not a directory\n");
      const context = await loadContext(directory, { _: [], processes: "registry-parent/processes.json" });
      const script = "setInterval(() => {}, 1000);";
      const logPath = path.join(directory, "register.log");

      const result = await runShell(context, `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`, logPath, "verify-1");

      expect(result.code).toBe(1);
      expect(result.output).toMatch(/Failed to register shell process/);
      expect(await readFile(logPath, "utf8")).toBe(result.output);
    } finally {
      await removeDir(directory);
    }
  });
});
