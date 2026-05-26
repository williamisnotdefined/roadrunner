import { describe, expect, test } from "vitest";

import { run as runRoadrunner } from "../src/application/runner.js";
import { queueFileFromRoadmap } from "../src/domain/roadmap.js";
import { removeDir, sampleRoadmap } from "./helpers.js";
import { setupRunnerProject } from "./runner-helpers.js";

describe("runner initial queues", () => {
  test("rejects invalid initial queues before running agents", async () => {
    const project = await setupRunnerProject("success");
    try {
      const queueFile = queueFileFromRoadmap(sampleRoadmap(), project.context.config);
      queueFile.queue[0]!.verification = [];

      await expect(runRoadrunner(project.context, { initialQueueFile: queueFile, maxSteps: 1 })).rejects.toThrow(/verification must be a non-empty array/);
    } finally {
      await removeDir(project.directory);
    }
  });

  test("rejects untrusted initial queue verification commands", async () => {
    const project = await setupRunnerProject("success");
    try {
      const queueFile = queueFileFromRoadmap(sampleRoadmap(), project.context.config);
      queueFile.queue[0]!.verification = ['node -e "process.exit(0)"'];

      await expect(runRoadrunner(project.context, { initialQueueFile: queueFile, maxSteps: 1 })).rejects.toThrow(/Verification commands were rejected before execution/);
    } finally {
      await removeDir(project.directory);
    }
  });
});
