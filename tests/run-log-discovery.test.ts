import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, test } from "vitest";

import { loadContext } from "../src/config.js";
import { discoverTaskLogs, readLogTail, relativeLogLabel } from "../src/run-log-discovery.js";
import { removeDir, tempDir } from "./helpers.js";

describe("run log discovery", () => {
  test("discovers task logs and includes the active log", async () => {
    const directory = await tempDir("roadrunner-log-discovery-");
    try {
      const context = await loadContext(directory, { _: [] });
      const planDir = path.join(context.paths.logs, "2026-01-01T00-00-00-000Z-first-step-plan");
      const runDir = path.join(context.paths.logs, "2026-01-01T00-01-00-000Z-first-step");
      const otherDir = path.join(context.paths.logs, "2026-01-01T00-02-00-000Z-other-step");
      await mkdir(planDir, { recursive: true });
      await mkdir(runDir, { recursive: true });
      await mkdir(otherDir, { recursive: true });
      await writeFile(path.join(planDir, "plan.md"), "plan\n");
      await writeFile(path.join(runDir, "implement.opencode.log"), "implemented\n");
      await writeFile(path.join(otherDir, "other.log"), "other\n");
      const active = path.join(directory, "external-active.log");
      await writeFile(active, "active\n");

      const logs = await discoverTaskLogs(context, "first-step", active);

      expect(logs.map((log) => log.label)).toEqual([
        "2026-01-01T00-00-00-000Z-first-step-plan/plan.md",
        "2026-01-01T00-01-00-000Z-first-step/implement.opencode.log",
        active,
      ]);
      expect(relativeLogLabel(context, path.join(runDir, "implement.opencode.log"))).toBe("2026-01-01T00-01-00-000Z-first-step/implement.opencode.log");
      await expect(discoverTaskLogs(context, "missing-step", null)).resolves.toEqual([]);
    } finally {
      await removeDir(directory);
    }
  });

  test("handles missing log directories", async () => {
    const directory = await tempDir("roadrunner-log-discovery-missing-");
    try {
      const context = await loadContext(directory, { _: [] });
      await expect(discoverTaskLogs(context, "first-step")).resolves.toEqual([]);
    } finally {
      await removeDir(directory);
    }
  });

  test("reads only the tail of large logs", async () => {
    const directory = await tempDir("roadrunner-log-tail-");
    try {
      const logPath = path.join(directory, "large.log");
      await writeFile(logPath, "0123456789");

      await expect(readLogTail(logPath, 4)).resolves.toBe("[Showing last 4 bytes of 10]\n6789");
    } finally {
      await removeDir(directory);
    }
  });
});
