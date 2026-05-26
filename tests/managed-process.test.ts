import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { describe, expect, test } from "vitest";

import { loadContext } from "../src/infrastructure/config.js";
import { runShell } from "../src/infrastructure/managed-process.js";
import { cleanupProcesses, readProcesses } from "../src/infrastructure/process-registry.js";
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

  test("keeps process registry records for background descendants", async () => {
    const directory = await tempDir("roadrunner-managed-process-child-");
    let childPid: number | null = null;
    try {
      const context = await loadContext(directory, { _: [] });
      const childPidFile = path.join(directory, "child.pid");
      const parentScriptPath = path.join(directory, "spawn-child.cjs");
      const childScript = "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);";
      const parentScript = [
        'const { spawn } = require("node:child_process");',
        'const fs = require("node:fs");',
        `const child = spawn(process.execPath, ["-e", ${JSON.stringify(childScript)}], { stdio: "ignore" });`,
        `fs.writeFileSync(${JSON.stringify(childPidFile)}, String(child.pid));`,
        "child.unref();",
      ].join("\n");
      await writeFile(parentScriptPath, parentScript);

      const result = await runShell(context, `${JSON.stringify(process.execPath)} ${JSON.stringify(parentScriptPath)}`, path.join(directory, "background.log"), "verify-1");
      childPid = Number(await readFile(childPidFile, "utf8"));

      expect(result.code).toBe(0);
      expect(processIsRunning(childPid)).toBe(true);
      expect(await readProcesses(context)).toEqual([expect.objectContaining({ role: "verify-1" })]);

      await cleanupProcesses(context, { force: true });
      await waitForProcessExit(childPid);

      expect(processIsRunning(childPid)).toBe(false);
      expect(await readProcesses(context)).toEqual([]);
    } finally {
      if (childPid !== null) killIfRunning(childPid);
      await removeDir(directory);
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

async function waitForProcessExit(pid: number, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && processIsRunning(pid)) await sleep(20);
}

function killIfRunning(pid: number): void {
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // Best-effort cleanup for failed assertions.
  }
}
