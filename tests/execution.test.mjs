import test from "node:test";
import assert from "node:assert/strict";

import { defaultModel, defaultVariant } from "../src/config.mjs";
import { formatStep, markDone, nextStep, validateExecution } from "../src/execution.mjs";

test("validates execution queue shape", () => {
  const execution = sampleExecution();

  assert.deepEqual(validateExecution(execution), []);
});

test("returns queue[0] as next step", () => {
  const step = nextStep(sampleExecution());

  assert.equal(step.id, "first-step");
  assert.match(formatStep(step), /first-step/);
});

test("moves completed queue item to history", () => {
  const execution = sampleExecution();

  markDone(execution, "first-step");

  assert.equal(execution.queue.length, 0);
  assert.equal(execution.history.length, 1);
  assert.equal(execution.history[0].id, "first-step");
  assert.equal(typeof execution.history[0].completedAt, "string");
});

function sampleExecution() {
  return {
    version: 1,
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
