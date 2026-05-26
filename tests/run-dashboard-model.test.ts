import { describe, expect, test } from "vitest";

import type { QueueFile, QueueStep } from "../src/domain/queue.js";
import { selectedTaskIndex, taskRowsFromQueue, taskStats, taskTableData } from "../src/ui/run-dashboard-model.js";

describe("run dashboard model", () => {
  test("maps queue state to task table rows", () => {
    const queueFile: QueueFile = {
      blocked: [{ ...step("blocked-step"), blockedReason: "needs input" }],
      history: [{ ...step("done-step"), completedAt: "2026-01-01T00:00:00.000Z" }],
      model: "openai/gpt-5.5",
      queue: [step("current-step"), step("next-step")],
      variant: "xhigh",
      version: 2,
    };

    const rows = taskRowsFromQueue(queueFile);

    expect(rows.map((row) => [row.status, row.id])).toEqual([
      ["done", "done-step"],
      ["current", "current-step"],
      ["next", "next-step"],
      ["blocked", "blocked-step"],
    ]);
    expect(taskStats(queueFile)).toEqual({ blocked: 1, current: 1, done: 1, next: 1 });
    expect(selectedTaskIndex(rows, null)).toBe(1);
    expect(selectedTaskIndex(rows, "next-step")).toBe(2);
    expect(taskTableData(rows, "current-step")[2]).toEqual(["› ▶ Now", "current-step", "Bootstrap", "Current Step"]);
  });

  test("handles empty queues and queues without a current task", () => {
    const empty: QueueFile = { blocked: [], history: [], model: "openai/gpt-5.5", queue: [], variant: "xhigh", version: 2 };
    expect(taskRowsFromQueue(empty)).toEqual([]);
    expect(taskStats(empty)).toEqual({ blocked: 0, current: 0, done: 0, next: 0 });
    expect(selectedTaskIndex([], null)).toBe(-1);

    const closedOnly: QueueFile = { ...empty, history: [step("done-step")] };
    const rows = taskRowsFromQueue(closedOnly);
    expect(selectedTaskIndex(rows, "missing-step")).toBe(0);
  });
});

function step(id: string): QueueStep {
  return {
    acceptance: ["works"],
    id,
    phase: "Bootstrap",
    prompt: "Build it.",
    scope: ["src/index.ts"],
    title: titleFromId(id),
    verification: ["npm test"],
  };
}

function titleFromId(id: string): string {
  return id
    .split("-")
    .map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`)
    .join(" ");
}
