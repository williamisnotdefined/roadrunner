import test from "node:test";
import assert from "node:assert/strict";

import { defaultModel, defaultVariant } from "../src/config.js";
import { formatStep, markDone, nextStep, validateQueueFile, type QueueFile } from "../src/queue.js";

test("validates queue shape", () => {
  const queueFile = sampleQueue();

  assert.deepEqual(validateQueueFile(queueFile), []);
});

test("returns queue[0] as next step", () => {
  const step = nextStep(sampleQueue());

  assert.equal(step?.id, "first-step");
  assert.match(formatStep(step), /first-step/);
});

test("moves completed queue item to history", () => {
  const queueFile = sampleQueue();

  markDone(queueFile, "first-step");

  assert.equal(queueFile.queue.length, 0);
  assert.equal(queueFile.history.length, 1);
  assert.equal(queueFile.history[0]?.id, "first-step");
  assert.equal(typeof queueFile.history[0]?.completedAt, "string");
});

function sampleQueue(): QueueFile {
  return {
    version: 2,
    source: "roadmap.md",
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
        commitMessage: "Do first step",
      },
    ],
    history: [],
    blocked: [],
  };
}
