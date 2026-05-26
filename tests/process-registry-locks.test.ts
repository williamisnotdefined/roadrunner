import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test, vi } from "vitest";

import { loadContext } from "../src/infrastructure/config.js";
import { readProcesses, registerProcess } from "../src/infrastructure/process-registry.js";

describe("process registry locks", () => {
  test("serializes concurrent process registrations", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "roadrunner-process-concurrent-"));
    const first = spawn("sleep", ["60"], { detached: true, stdio: "ignore" });
    const second = spawn("sleep", ["60"], { detached: true, stdio: "ignore" });
    try {
      const context = await loadContext(tempDir, { _: [] });
      expect(first.pid).toBeTruthy();
      expect(second.pid).toBeTruthy();

      await Promise.all([
        registerProcess({ command: ["sleep", "60"], cwd: tempDir, pid: first.pid!, role: "first" }, context),
        registerProcess({ command: ["sleep", "60"], cwd: tempDir, pid: second.pid!, role: "second" }, context),
      ]);

      expect((await readProcesses(context)).map((record) => record.role).sort()).toEqual(["first", "second"]);
    } finally {
      for (const child of [first, second]) killProcessGroup(child.pid);
      await rm(tempDir, { force: true, recursive: true });
    }
  });

  test("removes stale process registry locks", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "roadrunner-process-stale-lock-"));
    const child = spawn("sleep", ["60"], { detached: true, stdio: "ignore" });
    try {
      const context = await loadContext(tempDir, { _: [] });
      const lockPath = `${context.paths.processRegistry}.lock`;
      await mkdir(path.dirname(lockPath), { recursive: true });
      await writeFile(lockPath, `${JSON.stringify({ pid: 99999999, startedAt: new Date().toISOString() }, null, 2)}\n`);

      expect(child.pid).toBeTruthy();
      await registerProcess({ command: ["sleep", "60"], cwd: tempDir, pid: child.pid!, role: "test" }, context);

      expect(await readProcesses(context)).toEqual([expect.objectContaining({ pid: child.pid, role: "test" })]);
      await expect(readFile(lockPath, "utf8")).rejects.toThrow();
    } finally {
      killProcessGroup(child.pid);
      await rm(tempDir, { force: true, recursive: true });
    }
  });

  test("rejects corrupt process registry locks", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "roadrunner-process-corrupt-lock-"));
    const child = spawn("sleep", ["60"], { detached: true, stdio: "ignore" });
    const now = vi.spyOn(Date, "now");
    let currentTime = 0;
    now.mockImplementation(() => {
      currentTime += 10_000;
      return currentTime;
    });

    try {
      const context = await loadContext(tempDir, { _: [] });
      const lockPath = `${context.paths.processRegistry}.lock`;
      await mkdir(path.dirname(lockPath), { recursive: true });
      await writeFile(lockPath, "not json\n");

      expect(child.pid).toBeTruthy();
      await expect(registerProcess({ command: ["sleep", "60"], cwd: tempDir, pid: child.pid!, role: "test" }, context)).rejects.toThrow(/Process registry lock already exists/);
      await expect(readFile(lockPath, "utf8")).resolves.toBe("not json\n");
    } finally {
      now.mockRestore();
      killProcessGroup(child.pid);
      await rm(tempDir, { force: true, recursive: true });
    }
  });

  test("rejects malformed process registry locks", async () => {
    await expectRegistrationBlockedByLock({ pid: "not-a-pid", startedAt: new Date().toISOString() });
  });

  test("does not steal an active process registry lock", async () => {
    await expectRegistrationBlockedByLock({ pid: process.pid, startedAt: new Date().toISOString() });
  });
});

async function expectRegistrationBlockedByLock(lock: unknown): Promise<void> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "roadrunner-process-blocked-lock-"));
  const child = spawn("sleep", ["60"], { detached: true, stdio: "ignore" });
  const now = vi.spyOn(Date, "now");
  let currentTime = 0;
  now.mockImplementation(() => {
    currentTime += 10_000;
    return currentTime;
  });

  try {
    const context = await loadContext(tempDir, { _: [] });
    const lockPath = `${context.paths.processRegistry}.lock`;
    await mkdir(path.dirname(lockPath), { recursive: true });
    await writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`);

    expect(child.pid).toBeTruthy();
    await expect(registerProcess({ command: ["sleep", "60"], cwd: tempDir, pid: child.pid!, role: "test" }, context)).rejects.toThrow(/Process registry lock already exists/);
  } finally {
    now.mockRestore();
    killProcessGroup(child.pid);
    await rm(tempDir, { force: true, recursive: true });
  }
}

function killProcessGroup(pid: number | undefined): void {
  if (!pid) return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // already gone
  }
}
