import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { loadContext, pathExists } from "../src/config.js";
import { initProject } from "../src/init.js";

test("initProject creates Roadrunner project files", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "roadrunner-init-"));
  try {
    const context = await loadContext(tempDir, { _: [] });
    await initProject(context);
    const { paths } = context;

    assert.equal(await pathExists(paths.goals), true);
    assert.equal(await pathExists(paths.config), true);
    assert.equal(await pathExists(paths.queue), true);
    assert.equal(await pathExists(path.join(paths.prompts, "plan-step.md")), true);
    assert.match(await readFile(paths.goals, "utf8"), /Plan -> Execute -> Verify -> Commit -> Reconcile/);
  } finally {
    await rm(tempDir, { force: true, recursive: true });
  }
});

test("loadContext reads root Roadrunner config by default", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "roadrunner-config-"));
  try {
    await writeFile(
      path.join(tempDir, "roadrunner.config.json"),
      `${JSON.stringify({ paths: { queue: "ai/roadmap/queue.json" } }, null, 2)}\n`,
    );

    const context = await loadContext(tempDir, { _: [] });

    assert.equal(context.paths.config, path.join(tempDir, "roadrunner.config.json"));
    assert.equal(context.paths.queue, path.join(tempDir, "ai/roadmap/queue.json"));
  } finally {
    await rm(tempDir, { force: true, recursive: true });
  }
});
