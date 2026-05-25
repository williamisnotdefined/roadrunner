import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test, vi } from "vitest";

import { cleanupProcesses, readProcesses, registerProcess, unregisterProcess } from "../src/process-registry.js";
import { loadContext, writeJson } from "../src/config.js";

describe("process registry", () => {
  test("cleanup only targets registered child process", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "roadrunner-process-"));
    const child = spawn("sleep", ["60"], { detached: true, stdio: "ignore" });
    const context = await loadContext(tempDir, { _: [] });

    try {
      expect(child.pid).toBeTruthy();
      await registerProcess({ command: ["sleep", "60"], cwd: tempDir, pid: child.pid!, role: "test" }, context);
      expect((await readProcesses(context)).length).toBe(1);

      const results = await cleanupProcesses(context, { force: true });
      expect(results.some((result) => result.pid === child.pid)).toBe(true);
      expect((await readProcesses(context)).length).toBe(0);
    } finally {
      await rm(tempDir, { force: true, recursive: true });
    }
  });

  test("force cleanup sends SIGKILL to surviving process groups", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "roadrunner-process-force-"));
    const child = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"], { detached: true, stdio: "ignore" });
    const context = await loadContext(tempDir, { _: [] });
    const signals: unknown[] = [];
    const kill = vi.spyOn(process, "kill").mockImplementation((_pid, signal) => {
      signals.push(signal);
      return true;
    });

    try {
      expect(child.pid).toBeTruthy();
      await registerProcess({ command: [process.execPath], cwd: tempDir, pid: child.pid!, role: "stubborn" }, context);
      const records = await readProcesses(context);
      delete records[0]!.processGroupId;
      await writeJson(context.paths.processRegistry, { processes: records });

      const results = await cleanupProcesses(context, { force: true });

      expect(results).toContainEqual({ pid: child.pid, role: "stubborn", signal: "SIGKILL", status: "signaled" });
      expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
    } finally {
      kill.mockRestore();
      if (child.pid) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          // already gone
        }
      }
      await rm(tempDir, { force: true, recursive: true });
    }
  });

  test("rethrows unexpected process signaling errors", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "roadrunner-process-throw-"));
    const child = spawn("sleep", ["60"], { detached: true, stdio: "ignore" });
    const context = await loadContext(tempDir, { _: [] });
    const kill = vi.spyOn(process, "kill").mockImplementation(() => {
      const error = new Error("denied") as NodeJS.ErrnoException;
      error.code = "EPERM";
      throw error;
    });

    try {
      expect(child.pid).toBeTruthy();
      await registerProcess({ command: ["sleep", "60"], cwd: tempDir, pid: child.pid!, role: "test" }, context);
      await expect(cleanupProcesses(context)).rejects.toThrow(/denied/);
    } finally {
      kill.mockRestore();
      if (child.pid) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          // already gone
        }
      }
      await rm(tempDir, { force: true, recursive: true });
    }
  });

  test("records missing process groups when signaling returns ESRCH", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "roadrunner-process-esrch-"));
    const child = spawn("sleep", ["60"], { detached: true, stdio: "ignore" });
    const context = await loadContext(tempDir, { _: [] });
    const kill = vi.spyOn(process, "kill").mockImplementation(() => {
      const error = new Error("missing") as NodeJS.ErrnoException;
      error.code = "ESRCH";
      throw error;
    });

    try {
      expect(child.pid).toBeTruthy();
      await registerProcess({ command: ["sleep", "60"], cwd: tempDir, pid: child.pid!, role: "test" }, context);
      const results = await cleanupProcesses(context);
      expect(results).toContainEqual({ pid: child.pid, role: "test", signal: "SIGTERM", status: "missing" });
    } finally {
      kill.mockRestore();
      if (child.pid) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          // already gone
        }
      }
      await rm(tempDir, { force: true, recursive: true });
    }
  });

  test("does not signal tampered process group ids", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "roadrunner-process-tampered-pgid-"));
    const child = spawn("sleep", ["60"], { detached: true, stdio: "ignore" });
    const context = await loadContext(tempDir, { _: [] });
    const kill = vi.spyOn(process, "kill").mockImplementation(() => true);

    try {
      expect(child.pid).toBeTruthy();
      await registerProcess({ command: ["sleep", "60"], cwd: tempDir, pid: child.pid!, role: "test" }, context);
      const records = await readProcesses(context);
      records[0]!.processGroupId = child.pid! + 1;
      await writeJson(context.paths.processRegistry, { processes: records });

      expect(await cleanupProcesses(context)).toEqual([{ pid: child.pid, role: "test", status: "invalid-process-group" }]);
      expect(kill).not.toHaveBeenCalled();
      expect(await readProcesses(context)).toEqual([]);
    } finally {
      kill.mockRestore();
      if (child.pid) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          // already gone
        }
      }
      await rm(tempDir, { force: true, recursive: true });
    }
  });

  test("handles missing and corrupt registry files", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "roadrunner-process-corrupt-"));
    try {
      const context = await loadContext(tempDir, { _: [] });

      expect(await readProcesses(context)).toEqual([]);
      await mkdir(path.dirname(context.paths.processRegistry), { recursive: true });
      await writeFile(context.paths.processRegistry, "not json");
      expect(await readProcesses(context)).toEqual([]);
      await writeJson(context.paths.processRegistry, {});
      expect(await readProcesses(context)).toEqual([]);
    } finally {
      await rm(tempDir, { force: true, recursive: true });
    }
  });

  test("cleans records without explicit process group ids", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "roadrunner-process-no-pgid-"));
    const child = spawn("sleep", ["60"], { detached: true, stdio: "ignore" });
    const context = await loadContext(tempDir, { _: [] });

    try {
      expect(child.pid).toBeTruthy();
      await registerProcess({ command: ["sleep", "60"], cwd: tempDir, pid: child.pid!, role: "test" }, context);
      const records = await readProcesses(context);
      delete records[0]!.processGroupId;
      await writeJson(context.paths.processRegistry, { processes: records });

      const results = await cleanupProcesses(context);
      expect(results[0]).toMatchObject({ pid: child.pid, role: "test", signal: "SIGTERM" });
    } finally {
      if (child.pid) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          // already gone
        }
      }
      await rm(tempDir, { force: true, recursive: true });
    }
  });

  test("unregisters registered processes", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "roadrunner-process-unregister-"));
    const child = spawn("sleep", ["60"], { detached: true, stdio: "ignore" });
    try {
      const context = await loadContext(tempDir, { _: [] });
      expect(child.pid).toBeTruthy();
      await registerProcess({ command: ["sleep", "60"], cwd: tempDir, pid: child.pid!, role: "test" }, context);
      await unregisterProcess(child.pid!, context);
      expect(await readProcesses(context)).toEqual([]);
    } finally {
      if (child.pid) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          // already gone
        }
      }
      await rm(tempDir, { force: true, recursive: true });
    }
  });

  test("registering the same pid replaces its existing record", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "roadrunner-process-reregister-"));
    const child = spawn("sleep", ["60"], { detached: true, stdio: "ignore" });
    try {
      const context = await loadContext(tempDir, { _: [] });
      expect(child.pid).toBeTruthy();
      await registerProcess({ command: ["sleep", "60"], cwd: tempDir, pid: child.pid!, role: "first" }, context);
      await registerProcess({ command: ["sleep", "60"], cwd: tempDir, pid: child.pid!, role: "second" }, context);

      expect(await readProcesses(context)).toHaveLength(1);
      expect((await readProcesses(context))[0]?.role).toBe("second");
    } finally {
      if (child.pid) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          // already gone
        }
      }
      await rm(tempDir, { force: true, recursive: true });
    }
  });

  test("marks stale process records during cleanup", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "roadrunner-process-stale-"));
    try {
      const context = await loadContext(tempDir, { _: [] });
      await writeJson(context.paths.processRegistry, {
        processes: [{ command: ["missing"], cwd: tempDir, pid: 99999999, role: "stale", startTimeTicks: "old" }],
      });

      expect(await cleanupProcesses(context)).toEqual([{ pid: 99999999, role: "stale", status: "stale" }]);
      expect(await readProcesses(context)).toEqual([]);
    } finally {
      await rm(tempDir, { force: true, recursive: true });
    }
  });

  test("rejects registry records from a different cwd", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "roadrunner-process-cwd-"));
    try {
      const context = await loadContext(tempDir, { _: [] });
      await writeJson(context.paths.processRegistry, {
        processes: [{ command: ["missing"], cwd: path.dirname(tempDir), pid: 99999999, role: "tampered", startTimeTicks: "old" }],
      });

      expect(await cleanupProcesses(context)).toEqual([{ pid: 99999999, role: "tampered", status: "invalid-cwd" }]);
      expect(await readProcesses(context)).toEqual([]);
    } finally {
      await rm(tempDir, { force: true, recursive: true });
    }
  });

  test("treats records without start time as stale on Linux", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "roadrunner-process-no-start-"));
    try {
      const context = await loadContext(tempDir, { _: [] });
      await writeJson(context.paths.processRegistry, {
        processes: [{ command: [process.execPath], cwd: tempDir, pid: process.pid, role: "missing-start" }],
      });

      expect(await cleanupProcesses(context)).toEqual([{ pid: process.pid, role: "missing-start", status: "stale" }]);
    } finally {
      await rm(tempDir, { force: true, recursive: true });
    }
  });

  test("rejects registering missing pids", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "roadrunner-process-missing-"));
    try {
      const context = await loadContext(tempDir, { _: [] });

      await expect(registerProcess({ command: ["missing"], cwd: tempDir, pid: 99999999, role: "missing" }, context)).rejects.toThrow(/Cannot register pid/);
    } finally {
      await rm(tempDir, { force: true, recursive: true });
    }
  });
});
