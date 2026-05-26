import { describe, expect, test } from "vitest";

import { parseQueueProposalJson, queueProposalFromOutput } from "../src/application/queue-proposal.js";
import { defaultModel, defaultVariant, loadContext } from "../src/infrastructure/config.js";
import type { QueueFile } from "../src/domain/queue.js";
import { removeDir, tempDir } from "./helpers.js";

describe("queue proposals", () => {
  test("parses the tagged Roadrunner queue block", async () => {
    const directory = await tempDir("roadrunner-queue-proposal-");
    try {
      const context = await loadContext(directory, { _: [] });
      const queue = sampleQueue();

      expect(
        queueProposalFromOutput(
          `Summary\n\n\`\`\`json roadrunner-queue\n${JSON.stringify(queue, null, 2)}\n\`\`\`\n`,
          context,
        ),
      ).toEqual(queue);
    } finally {
      await removeDir(directory);
    }
  });

  test("rejects missing, ambiguous, invalid, and structurally invalid proposals", async () => {
    const directory = await tempDir("roadrunner-queue-proposal-invalid-");
    try {
      const context = await loadContext(directory, { _: [] });

      expect(() => parseQueueProposalJson("no json here")).toThrow(/fenced JSON block/);
      expect(() => parseQueueProposalJson("```json roadrunner-queue\n{}\n```\n```json roadrunner-queue\n{}\n```")).toThrow(/exactly one/);
      expect(() => queueProposalFromOutput("```json roadrunner-queue\nnot json\n```", context)).toThrow(/invalid/);
      expect(() => queueProposalFromOutput("```json roadrunner-queue\n{}\n```", context)).toThrow(/queue.version/);
    } finally {
      await removeDir(directory);
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
