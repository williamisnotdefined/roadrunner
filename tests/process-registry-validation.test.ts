import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test, vi } from "vitest";

import { cleanupProcesses, readProcesses, registerProcess } from "../src/infrastructure/process-registry.js";
import { loadContext, writeJson } from "../src/infrastructure/config.js";

describe("process registry validation", () => {
  test("drops tampered registry records with invalid process identities", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "roadrunner-process-invalid-records-"));
    const kill = vi.spyOn(process, "kill");
    try {
      const context = await loadContext(tempDir, { _: [] });
      await writeJson(context.paths.processRegistry, {
        processes: [
          { command: ["missing"], cwd: tempDir, pid: -process.pid, processGroupId: -process.pid, role: "negative" },
          { command: ["missing"], cwd: tempDir, pid: "1; invalid payload", processGroupId: "1; invalid payload", role: "string" },
          { command: "missing", cwd: tempDir, pid: process.pid, processGroupId: process.pid, role: "bad-command" },
        ],
      });

      expect(await readProcesses(context)).toEqual([]);
      expect(await cleanupProcesses(context)).toEqual([]);
      expect(kill.mock.calls.filter(([, signal]) => signal !== undefined && signal !== 0)).toEqual([]);
      expect(await readProcesses(context)).toEqual([]);
    } finally {
      kill.mockRestore();
      await rm(tempDir, { force: true, recursive: true });
    }
  });

  test("drops malformed registry records field by field", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "roadrunner-process-malformed-records-"));
    try {
      const context = await loadContext(tempDir, { _: [] });
      const valid = { command: ["node"], cwd: tempDir, pid: process.pid, role: "valid", startedAt: "2026-01-01T00:00:00.000Z", startTimeTicks: "1" };
      await writeJson(context.paths.processRegistry, {
        processes: [
          null,
          [],
          { ...valid, command: ["node", 1] },
          { ...valid, cwd: "" },
          { ...valid, processGroupId: 0 },
          { ...valid, role: "" },
          { ...valid, startedAt: "" },
          { ...valid, startTimeTicks: "" },
          valid,
        ],
      });

      expect(await readProcesses(context)).toEqual([valid]);
    } finally {
      await rm(tempDir, { force: true, recursive: true });
    }
  });

  test("rejects registering invalid pids before process lookup", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "roadrunner-process-invalid-register-"));
    try {
      const context = await loadContext(tempDir, { _: [] });

      await expect(registerProcess({ command: ["missing"], cwd: tempDir, pid: -1, role: "missing" }, context)).rejects.toThrow(/Cannot register pid/);
    } finally {
      await rm(tempDir, { force: true, recursive: true });
    }
  });
});
