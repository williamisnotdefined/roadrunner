import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { cleanupProcesses, readProcesses, registerProcess } from "../src/process-registry.js";
import { loadContext } from "../src/config.js";

test("cleanup only targets registered child process", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "roadrunner-process-"));
  const child = spawn("sleep", ["60"], { detached: true, stdio: "ignore" });
  const context = await loadContext(tempDir, { _: [] });

  try {
    assert.ok(child.pid);
    await registerProcess({ command: ["sleep", "60"], cwd: tempDir, pid: child.pid, role: "test" }, context);
    assert.equal((await readProcesses(context)).length, 1);

    const results = await cleanupProcesses(context, { force: true });
    assert.equal(results.some((result) => result.pid === child.pid), true);
    assert.equal((await readProcesses(context)).length, 0);
  } finally {
    await rm(tempDir, { force: true, recursive: true });
  }
});
