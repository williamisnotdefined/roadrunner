import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { initProject } from "../src/init.mjs";
import { pathExists, projectPaths } from "../src/config.mjs";

test("initProject creates Roadrunner project files", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "roadrunner-init-"));
  try {
    await initProject(tempDir);
    const paths = projectPaths(tempDir);

    assert.equal(await pathExists(paths.goals), true);
    assert.equal(await pathExists(paths.config), true);
    assert.equal(await pathExists(paths.execution), true);
    assert.equal(await pathExists(path.join(paths.prompts, "plan-step.md")), true);
    assert.match(await readFile(paths.goals, "utf8"), /Plan -> Execute -> Verify -> Commit -> Reconcile/);
  } finally {
    await rm(tempDir, { force: true, recursive: true });
  }
});
