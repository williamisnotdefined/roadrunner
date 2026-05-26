import { describe, expect, test } from "vitest";

import type { QueueFile, QueueStep } from "../src/domain/queue.js";
import { validateVerificationPolicy } from "../src/domain/verification-policy.js";

describe("verification policy", () => {
  test("groups untrusted verification commands with remediation steps", () => {
    const queueFile = queue(step({ verification: ["npm test", "cargo test", "npm run lint", "python -m pytest ml"] }));

    const errors = validateVerificationPolicy({
      allowedCommands: ["cargo test"],
      proposed: queueFile,
      trustedCommands: ["npm test"],
    });

    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("Verification commands were rejected before execution.");
    expect(errors[0]).toContain("queue[0] first-step verification[2]: npm run lint");
    expect(errors[0]).toContain("queue[0] first-step verification[3]: python -m pytest ml");
    expect(errors[0]).toContain("allowedVerificationCommands in roadrunner.config.json");
  });

  test("accepts trusted and allowed verification commands", () => {
    const queueFile = queue(step({ verification: ["npm test", "cargo test"] }));

    expect(validateVerificationPolicy({ allowedCommands: ["cargo test"], proposed: queueFile, trustedCommands: ["npm test"] })).toEqual([]);
  });

  test("formats locations even when an invalid proposal has no step id", () => {
    const queueFile = queue(step({ id: "", verification: ["npm test"] }));

    expect(validateVerificationPolicy({ proposed: queueFile })[0]).toContain("queue[0] verification[0]: npm test");
  });
});

function queue(firstStep: QueueStep): QueueFile {
  return { blocked: [], history: [], model: "model", queue: [firstStep], variant: "variant", version: 2 };
}

function step(overrides: Partial<QueueStep> = {}): QueueStep {
  return {
    acceptance: ["works"],
    id: "first-step",
    phase: "Phase",
    prompt: "Do it.",
    scope: ["src"],
    title: "First step",
    verification: ["npm test"],
    ...overrides,
  };
}
