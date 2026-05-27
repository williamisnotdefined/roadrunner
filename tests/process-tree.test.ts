import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { describe, expect, test } from "vitest";

import { hasLinuxAncestorPid, linuxProcessActivityKey, linuxProcessKey, linuxProcessSnapshotFromStat, readLinuxProcessSnapshot, sameLinuxProcess } from "../src/infrastructure/linux-process.js";
import { processTreeActivityKeys, processTreeExists, processTreeOwnerEnvKey, processTreeSnapshotKeys, readCurrentProcessTreeRoot, signalProcessTree } from "../src/infrastructure/process-tree.js";

describe("Linux process tree helpers", () => {
  test("treats unverifiable process roots as missing", () => {
    expect(processTreeExists(null)).toBe(false);
    expect(processTreeSnapshotKeys(undefined)).toEqual([]);
    expect(signalProcessTree({ pid: 1, processGroupId: 1, startTimeTicks: "" }, "SIGTERM")).toBe(false);
  });

  test("parses Linux process metadata from proc stat content", () => {
    const stat = processStat({ name: "node worker (busy)", parentPid: 7, pid: 123, processGroupId: 789, startTimeTicks: "9999", systemTimeTicks: "3", userTimeTicks: "12" });

    expect(linuxProcessSnapshotFromStat(123, stat)).toEqual({ parentPid: 7, pid: 123, processGroupId: 789, startTimeTicks: "9999", systemTimeTicks: "3", userTimeTicks: "12" });
    expect(linuxProcessActivityKey(linuxProcessSnapshotFromStat(123, stat)!)).toBe("123:9999:12:3");
    expect(linuxProcessSnapshotFromStat(123, "123 (node) S 1")).toBeNull();
    expect(linuxProcessSnapshotFromStat(123, "123 node) S 1 456 456 0")).toBeNull();
    expect(linuxProcessSnapshotFromStat(0, stat)).toBeNull();
    expect(linuxProcessSnapshotFromStat(123, "123 (node)S 1 456 456 0")).toBeNull();
    expect(linuxProcessSnapshotFromStat(123, processStat({ parentPid: "nope", pid: 123, processGroupId: 456, startTimeTicks: "1" }))).toBeNull();
    expect(linuxProcessSnapshotFromStat(123, processStat({ parentPid: 1, pid: 123, processGroupId: "nope", startTimeTicks: "1" }))).toBeNull();
    expect(readLinuxProcessSnapshot(0)).toBeNull();
  });

  test("checks Linux process ancestry and identity", () => {
    const snapshots = new Map([
      [1, { parentPid: 999, pid: 1, processGroupId: 1, startTimeTicks: "a", systemTimeTicks: "0", userTimeTicks: "0" }],
      [2, { parentPid: 1, pid: 2, processGroupId: 1, startTimeTicks: "b", systemTimeTicks: "1", userTimeTicks: "2" }],
      [3, { parentPid: 2, pid: 3, processGroupId: 1, startTimeTicks: "c", systemTimeTicks: "3", userTimeTicks: "4" }],
    ]);

    expect(hasLinuxAncestorPid(3, 1, snapshots)).toBe(true);
    expect(hasLinuxAncestorPid(3, 4, snapshots)).toBe(false);
    expect(sameLinuxProcess({ pid: 2, startTimeTicks: "b" }, snapshots.get(2))).toBe(true);
    expect(sameLinuxProcess({ pid: 2, startTimeTicks: "other" }, snapshots.get(2))).toBe(false);
    expect(linuxProcessKey(snapshots.get(3)!)).toBe("3:c");
    expect(linuxProcessActivityKey(snapshots.get(3)!)).toBe("3:c:4:3");
  });

  test("detects child processes in a verified process tree", async () => {
    const token = "roadrunner-process-tree-detect";
    const script = `const { spawn } = require("node:child_process"); spawn(process.execPath, ["-e", "setTimeout(() => {}, 10000)"], { stdio: "ignore" }); setTimeout(() => {}, 10000);`;
    const child = spawn(process.execPath, ["-e", script], { detached: true, env: { ...process.env, [processTreeOwnerEnvKey]: token }, stdio: "ignore" });
    try {
      const root = readCurrentProcessTreeRoot(child.pid, token);
      expect(root).not.toBeNull();
      await waitFor(() => processTreeSnapshotKeys(root).length > 1, 2_000);

      expect(processTreeExists(root)).toBe(true);
      const activityKeys = processTreeActivityKeys(root);
      expect(activityKeys).toContain(`${root!.pid}:${root!.startTimeTicks}`);
      expect(activityKeys.some((key) => /^\d+:\d+:\d+:\d+$/.test(key))).toBe(true);
    } finally {
      signalProcessTree(readCurrentProcessTreeRoot(child.pid, token), "SIGKILL");
      child.unref();
    }
  });

  test("signals child processes that moved to another process group", async () => {
    const token = "roadrunner-process-tree-detached";
    const directory = await mkdtemp(path.join(tmpdir(), "roadrunner-process-tree-"));
    const childPidPath = path.join(directory, "child.pid");
    const script = `const { spawn } = require("node:child_process"); const { writeFileSync } = require("node:fs"); const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 10000)"], { detached: true, stdio: "ignore" }); writeFileSync(${JSON.stringify(childPidPath)}, String(child.pid)); setTimeout(() => {}, 10000);`;
    const parent = spawn(process.execPath, ["-e", script], { detached: true, env: { ...process.env, [processTreeOwnerEnvKey]: token }, stdio: "ignore" });
    const root = readCurrentProcessTreeRoot(parent.pid, token);
    let childPid: number | null = null;

    try {
      expect(root).not.toBeNull();
      await waitFor(async () => {
        childPid = Number(await readFile(childPidPath, "utf8").catch(() => "0"));
        return Number.isSafeInteger(childPid) && childPid > 0 && processExists(childPid);
      }, 2_000);
      expect(processTreeSnapshotKeys(root).length).toBeGreaterThan(1);

      expect(signalProcessTree(root, "SIGKILL")).toBe(true);
      await waitFor(() => !processExists(parent.pid) && !processExists(childPid ?? 0), 2_000);
    } finally {
      signalProcessTree(root, "SIGKILL");
      if (childPid) killPid(childPid);
      parent.unref();
      await rm(directory, { force: true, recursive: true });
    }
  });

  test("signals owner-token descendants after the root process exits", async () => {
    const token = "roadrunner-process-tree-owner";
    const directory = await mkdtemp(path.join(tmpdir(), "roadrunner-process-owner-"));
    const childPidPath = path.join(directory, "child.pid");
    const script = `const { spawn } = require("node:child_process"); const { writeFileSync } = require("node:fs"); const child = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"], { stdio: "ignore" }); writeFileSync(${JSON.stringify(childPidPath)}, String(child.pid)); child.unref();`;
    const parent = spawn(process.execPath, ["-e", script], { detached: true, env: { ...process.env, [processTreeOwnerEnvKey]: token }, stdio: "ignore" });
    const root = readCurrentProcessTreeRoot(parent.pid, token);
    let childPid: number | null = null;

    try {
      expect(root).not.toBeNull();
      await waitFor(async () => {
        childPid = Number(await readFile(childPidPath, "utf8").catch(() => "0"));
        return Number.isSafeInteger(childPid) && childPid > 0 && processExists(childPid);
      }, 2_000);
      await waitFor(() => !processExists(parent.pid), 2_000);

      expect(signalProcessTree(root, "SIGKILL")).toBe(true);
      await waitFor(() => !processExists(childPid ?? 0), 2_000);
    } finally {
      signalProcessTree(root, "SIGKILL");
      if (childPid) killPid(childPid);
      parent.unref();
      await rm(directory, { force: true, recursive: true });
    }
  });
});

function processStat({ name = "node", parentPid, pid, processGroupId, startTimeTicks, systemTimeTicks = "0", userTimeTicks = "0" }: { name?: string; parentPid: number | string; pid: number; processGroupId: number | string; startTimeTicks: string; systemTimeTicks?: string; userTimeTicks?: string }): string {
  return `${pid} (${name}) ${["S", String(parentPid), String(processGroupId), "456", ...Array(7).fill("0"), userTimeTicks, systemTimeTicks, ...Array(6).fill("0"), startTimeTicks].join(" ")}`;
}

async function waitFor(condition: () => boolean | Promise<boolean>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for condition.");
    await sleep(20);
  }
}

function processExists(pid: number | undefined): boolean {
  if (pid === undefined || !Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function killPid(pid: number): void {
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    return;
  }
}
