import { describe, expect, test } from "vitest";

import { defaultModel, defaultVariant, loadContext, readJson, writeJson } from "../src/config.js";
import type { QueueFile, QueueStep } from "../src/queue.js";
import { blockStep } from "../src/queue-service.js";
import { removeDir, tempDir } from "./helpers.js";

describe("queue service", () => {
  test("blocks the latest matching current step", async () => {
    const project = await tempDir("roadrunner-queue-service-latest-");
    try {
      const context = await loadContext(project, { _: [] });
      const queue = sampleQueue();
      const latest = sampleQueue();
      latest.queue[1] = { ...latest.queue[1]!, title: "Updated second" };
      await writeJson(context.paths.queue, latest);

      await blockStep(context, queue, queue.queue[0]!, "blocked");

      const written = await readJson<QueueFile>(context.paths.queue);
      expect(written.blocked[0]).toMatchObject({ blockedReason: "blocked", id: "first-step" });
      expect(written.queue[0]).toMatchObject({ id: "second-step", title: "Updated second" });
    } finally {
      await removeDir(project);
    }
  });

  test("falls back to the provided queue when the latest current step differs", async () => {
    const project = await tempDir("roadrunner-queue-service-current-differs-");
    try {
      const context = await loadContext(project, { _: [] });
      const queue = sampleQueue();
      const latest = sampleQueue();
      latest.queue.unshift({ ...latest.queue[0]!, id: "other-step", title: "Other step" });
      await writeJson(context.paths.queue, latest);

      await blockStep(context, queue, queue.queue[0]!, "blocked");

      const written = await readJson<QueueFile>(context.paths.queue);
      expect(written.blocked[0]).toMatchObject({ id: "first-step" });
      expect(written.queue.map((step) => step.id)).toEqual(["second-step"]);
    } finally {
      await removeDir(project);
    }
  });

  test("falls back to the provided queue when the latest queue is invalid", async () => {
    const project = await tempDir("roadrunner-queue-service-invalid-");
    try {
      const context = await loadContext(project, { _: [] });
      const queue = sampleQueue();
      await writeJson(context.paths.queue, { version: 99 });

      await blockStep(context, queue, queue.queue[0]!, "blocked");

      const written = await readJson<QueueFile>(context.paths.queue);
      expect(written.version).toBe(2);
      expect(written.blocked[0]).toMatchObject({ id: "first-step" });
    } finally {
      await removeDir(project);
    }
  });
});

function sampleQueue(): QueueFile {
  return {
    version: 2,
    model: defaultModel,
    variant: defaultVariant,
    queue: [sampleStep("first-step", "First step"), sampleStep("second-step", "Second step")],
    history: [],
    blocked: [],
  };
}

function sampleStep(id: string, title: string): QueueStep {
  return {
    id,
    phase: "Test",
    title,
    scope: ["README.md"],
    prompt: "Do it.",
    acceptance: ["works"],
    verification: ["npm test"],
  };
}
