import { PassThrough } from "node:stream";

import { describe, expect, test } from "vitest";

import type { QueueStep } from "../src/queue.js";
import { createRunFeedback } from "../src/run-cli-feedback.js";

const sampleStep: QueueStep = {
  acceptance: ["works"],
  id: "sample-step",
  phase: "Sample",
  prompt: "Build it.",
  scope: ["src/sample.ts"],
  title: "Ship Sample",
  verification: ["npm test"],
};

describe("run CLI feedback", () => {
  test("does not render heartbeat controls when non-interactive", () => {
    const output: string[] = [];
    const terminalOutput: string[] = [];
    const feedback = createRunFeedback({
      interactive: false,
      stdout: (message) => output.push(message),
      terminal: {
        clearLine: () => terminalOutput.push("clear"),
        cursorTo: () => terminalOutput.push("cursor"),
        write: (message) => terminalOutput.push(message),
      },
    });

    feedback.beforeEvent();
    feedback.onEvent({ step: sampleStep, type: "step" });
    feedback.onEvent({ step: sampleStep, type: "implement" });
    feedback.onEvent({ command: ["opencode"], debug: false, logPath: "/tmp/implement.log", pid: 123, role: "implement", step: sampleStep, type: "provider-start" });
    feedback.onEvent({ attempt: 2, step: sampleStep, type: "task-restart" });
    feedback.onEvent({ type: "cleanup" });
    feedback.stop();
    feedback.stop();

    expect(output).toEqual([]);
    expect(terminalOutput).toEqual([]);
  });

  test("reports rstask when no task attempt is active", async () => {
    const input = new PassThrough();
    const output: string[] = [];
    const feedback = createRunFeedback({
      input,
      interactive: true,
      stdout: (message) => output.push(message),
      terminal: {
        clearLine: () => {},
        cursorTo: () => {},
        write: () => {},
      },
    });

    input.write("noop\n");
    input.write("rstask\n");
    await new Promise<void>((resolve) => setImmediate(resolve));
    feedback.onEvent({ type: "cleanup" });
    feedback.stop();

    expect(output.join("\n")).toMatch(/type rstask/);
    expect(output.join("\n")).toMatch(/no active task attempt/);
  });
});
