import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { cleanupProcesses, readProcesses, registerProcess } from "../src/process-registry.mjs";

test("cleanup only targets registered child process", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "roadrunner-process-"));
  const child = spawn("sleep", ["60"], { detached: true, stdio: "ignore" });

  try {
    await registerProcess({ command: ["sleep", "60"], cwd: tempDir, pid: child.pid, role: "test" }, tempDir);
    assert.equal((await readProcesses(tempDir)).length, 1);

    const results = await cleanupProcesses(tempDir, { force: true });
    assert.equal(results.some((result) => result.pid === child.pid), true);
    assert.equal((await readProcesses(tempDir)).length, 0);
  } finally {
    await rm(tempDir, { force: true, recursive: true });
  }
});
