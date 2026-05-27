import { afterEach, describe, expect, test, vi } from "vitest";

import { createAttemptActivityTracker } from "../src/application/attempt-activity.js";
import type { RoadrunnerRunActivityEvent, RoadrunnerRunEvent } from "../src/application/runner.js";
import type { QueueStep } from "../src/domain/queue.js";
import type { ProcessTreeRoot } from "../src/infrastructure/process-tree.js";

const step: QueueStep = {
  acceptance: ["works"],
  id: "sample-step",
  phase: "Sample",
  prompt: "Build it.",
  scope: ["src/sample.ts"],
  title: "Ship Sample",
  verification: ["npm test"],
};

const root: ProcessTreeRoot = { ownerToken: "token", pid: 123, processGroupId: 123, startTimeTicks: "1" };

afterEach(() => {
  vi.useRealTimers();
});

describe("attempt activity tracker", () => {
  test("tracks provider starts and process tree activity", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const events: RoadrunnerRunEvent[] = [];
    const activities: RoadrunnerRunActivityEvent[] = [];
    let processTreeActivity: (() => void) | undefined;
    let stopped = false;
    const current = attemptState();
    const tracker = createAttemptActivityTracker({
      current,
      emitActivity: (event) => activities.push(event),
      emitEvent: (event) => events.push(event),
      idleMs: 500,
      startMonitor: ({ onActivity }) => {
        processTreeActivity = onActivity;
        return () => {
          stopped = true;
        };
      },
      step,
    });

    tracker.setPhase("implement");
    vi.setSystemTime(100);
    tracker.recordProviderStart({ command: ["opencode"], debug: false, logPath: "/tmp/opencode.log", pid: 123, processTreeRoot: root, role: "implement" });
    vi.setSystemTime(200);
    processTreeActivity?.();
    tracker.stop();

    expect(current.providerProcess).toBeNull();
    expect(current.lastActivityAt).toBe(200);
    expect(events).toEqual([expect.objectContaining({ processTreeRoot: root, step, type: "provider-start" })]);
    expect(activities).toEqual([{ phase: "implement", step }]);
    expect(stopped).toBe(true);
  });

  test("handles provider starts without process roots", () => {
    const events: RoadrunnerRunEvent[] = [];
    const tracker = createAttemptActivityTracker({ current: attemptState(), emitActivity: () => {}, emitEvent: (event) => events.push(event), idleMs: 500, step });

    tracker.recordProviderStart({ command: ["opencode"], debug: false, logPath: "/tmp/missing.log", pid: null, processTreeRoot: null, role: "plan" });

    expect(events).toEqual([expect.objectContaining({ pid: null, processTreeRoot: null, type: "provider-start" })]);
  });

  test("uses plan as the fallback process-tree activity phase", () => {
    const activities: RoadrunnerRunActivityEvent[] = [];
    let processTreeActivity: (() => void) | undefined;
    const tracker = createAttemptActivityTracker({
      current: attemptState(),
      emitActivity: (event) => activities.push(event),
      emitEvent: () => {},
      idleMs: 500,
      startMonitor: ({ onActivity }) => {
        processTreeActivity = onActivity;
        return () => {};
      },
      step,
    });

    tracker.recordProviderStart({ command: ["opencode"], debug: false, logPath: "/tmp/opencode.log", pid: 123, processTreeRoot: root, role: "plan" });
    processTreeActivity?.();

    expect(activities).toEqual([{ phase: "plan", step }]);
  });

  test("uses a normal monitor interval when auto restart is disabled", () => {
    let intervalMs: number | undefined;
    const tracker = createAttemptActivityTracker({
      current: attemptState(),
      emitActivity: () => {},
      emitEvent: () => {},
      idleMs: 0,
      startMonitor: (input) => {
        intervalMs = input.intervalMs;
        return () => {};
      },
      step,
    });

    tracker.recordProviderStart({ command: ["opencode"], debug: false, logPath: "/tmp/opencode.log", pid: 123, processTreeRoot: root, role: "plan" });

    expect(intervalMs).toBe(1_000);
  });
});

function attemptState() {
  return {
    abortController: new AbortController(),
    lastActivityAt: Date.now(),
    phase: null,
    providerProcess: null,
    restartReason: null,
    restartRequested: false,
    startedAt: Date.now(),
    step,
  };
}
