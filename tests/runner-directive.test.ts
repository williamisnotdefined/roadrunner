import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, test } from "vitest";

import { run as runRoadrunner } from "../src/application/runner.js";
import { removeDir } from "./helpers.js";
import { logDirFor, setupRunnerProject } from "./runner-helpers.js";

describe("runner operator directives", () => {
  test("passes operator directives into run prompts", async () => {
    const project = await setupRunnerProject("startup-refresh-inferred-done");
    try {
      expect(await runRoadrunner(project.context, { operatorDirective: "Prefer fixture-first implementation." })).toBe(0);
      const prompt = await readFile(path.join(await logDirFor(project.context, "startup-refresh"), "startup-refresh.prompt.md"), "utf8");

      expect(prompt).toContain("Prefer fixture-first implementation.");
    } finally {
      await removeDir(project.directory);
    }
  });
});
