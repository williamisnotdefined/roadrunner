import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, test } from "vitest";

import { reconcileProjectQueue } from "../src/application/global-reconciliation.js";
import { readRunSnapshot } from "../src/application/run-snapshot.js";
import { queueFileFromRoadmap } from "../src/domain/roadmap.js";
import { removeDir, sampleRoadmap } from "./helpers.js";
import { setupRunnerProject } from "./runner-helpers.js";

describe("global reconciliation", () => {
  test("reconciles the open queue with an operator directive without editing docs", async () => {
    const project = await setupRunnerProject("reconcile-queue");
    try {
      const beforeGoals = await readFile(project.context.paths.goals, "utf8");
      const beforeRoadmap = await readFile(project.context.paths.roadmap, "utf8");
      const queueFile = queueFileFromRoadmap(sampleRoadmap(), project.context.config);
      const snapshot = await readRunSnapshot(project.context, { operatorDirective: "Prefer a fixture-first plan." });

      const result = await reconcileProjectQueue(project.context, queueFile, snapshot, { deadline: null });
      const prompt = await readFile(path.join(result.logDir, "global-reconcile.prompt.md"), "utf8");

      expect(result.queueFile.queue[0]?.title).toBe("Reconciled first step");
      expect(prompt).toContain("Prefer a fixture-first plan.");
      expect(await readFile(project.context.paths.goals, "utf8")).toBe(beforeGoals);
      expect(await readFile(project.context.paths.roadmap, "utf8")).toBe(beforeRoadmap);
    } finally {
      await removeDir(project.directory);
    }
  });

  test("reconciles when the roadmap file is absent", async () => {
    const project = await setupRunnerProject("reconcile-queue");
    try {
      project.context.paths.roadmap = path.join(project.directory, "MISSING.md");
      const queueFile = queueFileFromRoadmap(sampleRoadmap(), project.context.config);
      const snapshot = await readRunSnapshot(project.context, { operatorDirective: "Use repository evidence only." });

      await expect(reconcileProjectQueue(project.context, queueFile, snapshot, { deadline: null })).resolves.toMatchObject({ queueFile: { queue: [expect.objectContaining({ title: "Reconciled first step" })] } });
    } finally {
      await removeDir(project.directory);
    }
  });

  test.each([
    ["reconcile-fail", /Global reconciliation provider failed/],
    ["reconcile-invalid", /queue.version/],
    ["reconcile-wrong-model", /queue.model/],
    ["reconcile-wrong-variant", /queue.variant/],
    ["reconcile-empty-scope", /scope must be a non-empty array/],
  ])("rejects invalid global reconcile proposals from %s", async (mode, message) => {
    const project = await setupRunnerProject(mode);
    try {
      const queueFile = queueFileFromRoadmap(sampleRoadmap(), project.context.config);
      const snapshot = await readRunSnapshot(project.context, { operatorDirective: "Keep closed records stable." });

      await expect(reconcileProjectQueue(project.context, queueFile, snapshot, { deadline: null })).rejects.toThrow(message);
    } finally {
      await removeDir(project.directory);
    }
  });
});
