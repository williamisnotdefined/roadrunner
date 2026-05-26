import { afterEach, describe, expect, test, vi } from "vitest";

import { recordAttemptActivity, startAutoRestartWatchdog, type RestartableAttemptState } from "../src/application/auto-restart-watchdog.js";
import type { QueueStep } from "../src/domain/queue.js";
import type { RoadrunnerRunEvent } from "../src/application/runner.js";

const step: QueueStep = {
  acceptance: ["works"],
  id: "sample-step",
  phase: "Sample",
  prompt: "Build it.",
  scope: ["src/sample.ts"],
  title: "Ship Sample",
  verification: ["npm test"],
};

afterEach(() => {
  vi.useRealTimers();
});

describe("auto restart watchdog", () => {
  test("does nothing when disabled", () => {
    vi.useFakeTimers();
    const state = attemptState();
    const events: RoadrunnerRunEvent[] = [];
    const stop = startAutoRestartWatchdog({ current: state, emitEvent: (event) => events.push(event), incrementRestartCount: () => 1, policy: { enabled: false, idleMs: 10, maxRestarts: 1 }, restartCount: () => 0 });

    vi.advanceTimersByTime(20);
    stop();

    expect(state.restartRequested).toBe(false);
    expect(events).toEqual([]);
  });

  test("waits for the full idle window after activity", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const state = attemptState();
    const events: RoadrunnerRunEvent[] = [];
    let restarts = 0;

    const stop = startAutoRestartWatchdog({
      current: state,
      emitEvent: (event) => events.push(event),
      incrementRestartCount: () => {
        restarts += 1;
        return restarts;
      },
      policy: { enabled: true, idleMs: 10, maxRestarts: 1 },
      restartCount: () => restarts,
    });

    vi.advanceTimersByTime(5);
    recordAttemptActivity(state);
    vi.advanceTimersByTime(5);
    expect(state.restartRequested).toBe(false);

    vi.advanceTimersByTime(5);
    stop();

    expect(state.restartReason).toMatchObject({ restart: 1, type: "auto" });
    expect(events).toEqual([expect.objectContaining({ restart: 1, type: "task-auto-restart-requested" })]);
  });

  test("does not emit twice after a restart was already requested", () => {
    vi.useFakeTimers();
    const state = attemptState();
    state.restartRequested = true;
    const events: RoadrunnerRunEvent[] = [];
    const stop = startAutoRestartWatchdog({ current: state, emitEvent: (event) => events.push(event), incrementRestartCount: () => 1, policy: { enabled: true, idleMs: 10, maxRestarts: 1 }, restartCount: () => 0 });

    vi.advanceTimersByTime(10);
    stop();

    expect(events).toEqual([]);
  });

  test("does not restart local verification phases", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const state = attemptState();
    state.phase = "verify";
    const events: RoadrunnerRunEvent[] = [];
    const stop = startAutoRestartWatchdog({ current: state, emitEvent: (event) => events.push(event), incrementRestartCount: () => 1, policy: { enabled: true, idleMs: 10, maxRestarts: 1 }, restartCount: () => 0 });

    vi.advanceTimersByTime(100);
    stop();

    expect(state.restartRequested).toBe(false);
    expect(events).toEqual([]);
  });
});

function attemptState(): RestartableAttemptState {
  return {
    abortController: new AbortController(),
    lastActivityAt: Date.now(),
    phase: "plan",
    restartReason: null,
    restartRequested: false,
    startedAt: Date.now(),
    step,
  };
}
