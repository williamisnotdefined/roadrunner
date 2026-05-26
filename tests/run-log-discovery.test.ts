import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, test } from "vitest";

import { loadContext } from "../src/infrastructure/config.js";
import { discoverTaskLogs, readLogTail, relativeLogLabel } from "../src/ui/run-log-discovery.js";
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
      await writeFile(path.join(planDir, "plan.opencode.log"), "plan\n");
      await writeFile(path.join(runDir, "implement.opencode.log"), "implemented\n");
      await writeFile(path.join(otherDir, "other.log"), "other\n");
      const active = path.join(directory, "external-active.log");
      await writeFile(active, "active\n");

      const logs = await discoverTaskLogs(context, "first-step", active);

      expect(logs.map((log) => log.label)).toEqual([
        "ACTIVE external active",
        "implement · 00:01:00",
        "plan · 00:00:00",
      ]);
      expect(logs[1]).toMatchObject({ active: false, relativePath: "2026-01-01T00-01-00-000Z-first-step/implement.opencode.log", role: "implement", time: "00:01:00" });
      expect(relativeLogLabel(context, path.join(runDir, "implement.opencode.log"))).toBe("2026-01-01T00-01-00-000Z-first-step/implement.opencode.log");
      await expect(discoverTaskLogs(context, "missing-step", null)).resolves.toEqual([]);
    } finally {
      await removeDir(directory);
    }
  });

  test("matches task log directories by exact task id", async () => {
    const directory = await tempDir("roadrunner-log-discovery-exact-");
    try {
      const context = await loadContext(directory, { _: [] });
      const exactDir = path.join(context.paths.logs, "2026-01-01T00-00-00-000Z-step");
      const suffixDir = path.join(context.paths.logs, "2026-01-01T00-01-00-000Z-first-step");
      await mkdir(exactDir, { recursive: true });
      await mkdir(suffixDir, { recursive: true });
      await writeFile(path.join(exactDir, "implement.opencode.log"), "exact\n");
      await writeFile(path.join(suffixDir, "implement.opencode.log"), "suffix\n");

      const logs = await discoverTaskLogs(context, "step");

      expect(logs.map((log) => log.relativePath)).toEqual(["2026-01-01T00-00-00-000Z-step/implement.opencode.log"]);
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

  test("labels active logs without file extensions", async () => {
    const directory = await tempDir("roadrunner-log-discovery-active-");
    try {
      const context = await loadContext(directory, { _: [] });
      const active = path.join(directory, "active-log");
      await writeFile(active, "active\n");

      await expect(discoverTaskLogs(context, "first-step", active)).resolves.toEqual([expect.objectContaining({ label: "ACTIVE active log", role: "active log" })]);
    } finally {
      await removeDir(directory);
    }
  });

  test("ignores matching log entries that are not directories", async () => {
    const directory = await tempDir("roadrunner-log-discovery-file-");
    try {
      const context = await loadContext(directory, { _: [] });
      await mkdir(context.paths.logs, { recursive: true });
      await writeFile(path.join(context.paths.logs, "2026-01-01T00-00-00-000Z-first-step"), "not a directory\n");

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

  test("reads complete logs smaller than the tail limit", async () => {
    const directory = await tempDir("roadrunner-log-tail-small-");
    try {
      const logPath = path.join(directory, "small.log");
      await writeFile(logPath, "small\n");

      await expect(readLogTail(logPath, 100)).resolves.toBe("small\n");
    } finally {
      await removeDir(directory);
    }
  });

  test("does not start log tails on UTF-8 continuation bytes", async () => {
    const directory = await tempDir("roadrunner-log-tail-utf8-");
    try {
      const logPath = path.join(directory, "utf8.log");
      const content = "abcédef";
      await writeFile(logPath, content);

      await expect(readLogTail(logPath, 4)).resolves.toBe(`[Showing last 4 bytes of ${Buffer.byteLength(content)}]\ndef`);
    } finally {
      await removeDir(directory);
    }
  });
});
