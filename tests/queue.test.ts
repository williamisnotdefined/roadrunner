import { describe, expect, test } from "vitest";

import { defaultModel, defaultVariant } from "../src/config.js";
import { formatStep, markBlocked, markDone, nextStep, validateGoals, validateQueueFile, type QueueFile } from "../src/queue.js";
import { tempDir, removeDir } from "./helpers.js";
import { writeFile } from "node:fs/promises";
import path from "node:path";

describe("queue", () => {
  test("validates queue shape", () => {
    const queueFile = sampleQueue();

    expect(validateQueueFile(queueFile)).toEqual([]);
    expect(validateQueueFile({ ...queueFile, model: "custom", variant: "low" }, { model: "custom", variant: "low" })).toEqual([]);
  });

  test("rejects duplicate step IDs across queue state", () => {
    const queueFile = sampleQueue();
    queueFile.history.push({ ...queueFile.queue[0]! });

    expect(validateQueueFile(queueFile)).toContain("history[0].id duplicates queue[0].id.");
  });

  test("returns queue[0] as next step", () => {
    const step = nextStep(sampleQueue());

    expect(step?.id).toBe("first-step");
    expect(formatStep(step)).toMatch(/first-step/);
    expect(nextStep({ ...sampleQueue(), queue: [] })).toBeNull();
    expect(formatStep(null)).toBe("No queued step.");
  });

  test("moves completed queue item to history", () => {
    const queueFile = sampleQueue();

    markDone(queueFile, "first-step");

    expect(queueFile.queue.length).toBe(0);
    expect(queueFile.history.length).toBe(1);
    expect(queueFile.history[0]?.id).toBe("first-step");
    expect(typeof queueFile.history[0]?.completedAt).toBe("string");
  });

  test("rejects non-string array entries", () => {
    const queueFile = sampleQueue();
    queueFile.queue[0]!.verification = [123 as unknown as string];

    expect(validateQueueFile(queueFile)).toEqual(["queue[0].verification[0] must be a non-empty string."]);
  });

  test("moves blocked queue item to blocked list", () => {
    const queueFile = sampleQueue();

    markBlocked(queueFile, "first-step", "blocked reason");

    expect(queueFile.queue).toEqual([]);
    expect(queueFile.blocked[0]).toMatchObject({ blockedReason: "blocked reason", id: "first-step" });
    expect(typeof queueFile.blocked[0]?.blockedAt).toBe("string");
  });

  test("rejects completing or blocking non-current steps", () => {
    const queueFile = sampleQueue();

    expect(() => markDone(queueFile, "other-step")).toThrow(/Can only complete queue\[0]/);
    expect(() => markBlocked(queueFile, "other-step", "reason")).toThrow(/Can only block queue\[0]/);
  });

  test("reports queue shape errors", () => {
    expect(validateQueueFile({ version: 1, model: "bad", variant: "bad", queue: {}, history: {}, blocked: {} })).toEqual([
      "queue.version must be 2.",
      "queue.model must be openai/gpt-5.5.",
      "queue.variant must be xhigh.",
      "queue.queue must be an array.",
      "queue.history must be an array.",
      "queue.blocked must be an array.",
    ]);
    expect(validateQueueFile(null)).toEqual([
      "queue.version must be 2.",
      "queue.model must be openai/gpt-5.5.",
      "queue.variant must be xhigh.",
      "queue.queue must be an array.",
      "queue.history must be an array.",
      "queue.blocked must be an array.",
    ]);
  });

  test("reports invalid step fields", () => {
    const queueFile = sampleQueue();
    queueFile.queue[0] = {
      acceptance: [],
      id: "Bad ID",
      phase: "",
      prompt: "",
      scope: [],
      title: "",
      verification: [],
    };

    expect(validateQueueFile(queueFile)).toEqual([
      "queue[0].id must be kebab-case.",
      "queue[0].phase must be a non-empty string.",
      "queue[0].title must be a non-empty string.",
      "queue[0].prompt must be a non-empty string.",
      "queue[0].scope must be a non-empty array.",
      "queue[0].acceptance must be a non-empty array.",
      "queue[0].verification must be a non-empty array.",
    ]);

    expect(validateQueueFile({ ...sampleQueue(), queue: [undefined as never] })).toContain("queue[0].id must be kebab-case.");
  });

  test("validates goals file", async () => {
    const directory = await tempDir("roadrunner-goals-");
    try {
      const context = { paths: { goals: path.join(directory, "GOALS.md") } } as Parameters<typeof validateGoals>[0];

      expect(await validateGoals(context)).toEqual(["GOALS.md must exist."]);
      await writeFile(context.paths.goals, "\n");
      expect(await validateGoals(context)).toEqual(["GOALS.md must not be empty."]);
      await writeFile(context.paths.goals, "# Goals\n");
      expect(await validateGoals(context)).toEqual([]);
    } finally {
      await removeDir(directory);
    }
  });

  test("validates configured goals path labels", async () => {
    const directory = await tempDir("roadrunner-goals-custom-");
    const outside = await tempDir("roadrunner-goals-outside-");
    try {
      const context = { paths: { goals: path.join(directory, "docs/GOALS.md") }, root: directory } as Parameters<typeof validateGoals>[0];
      const outsideContext = { paths: { goals: path.join(outside, "GOALS.md") }, root: directory } as Parameters<typeof validateGoals>[0];

      expect(await validateGoals(context)).toEqual(["docs/GOALS.md must exist."]);
      expect(await validateGoals(outsideContext)).toEqual([`${path.join(outside, "GOALS.md")} must exist.`]);
    } finally {
      await removeDir(directory);
      await removeDir(outside);
    }
  });
});

function sampleQueue(): QueueFile {
  return {
    version: 2,
    model: defaultModel,
    variant: defaultVariant,
    queue: [
      {
        id: "first-step",
        phase: "Test",
        title: "First step",
        scope: ["README.md"],
        prompt: "Do the thing.",
        acceptance: ["it works"],
        verification: ["npm test"],
      },
    ],
    history: [],
    blocked: [],
  };
}
