import { afterEach, describe, expect, test, vi } from "vitest";

import { sameProcessKeySet, startProcessTreeActivityMonitor } from "../src/infrastructure/process-tree-activity.js";
import type { ProcessTreeRoot } from "../src/infrastructure/process-tree.js";

const root: ProcessTreeRoot = { pid: 1, processGroupId: 1, startTimeTicks: "root" };

afterEach(() => {
  vi.useRealTimers();
});

describe("process tree activity monitor", () => {
  test("compares process key sets independent of order", () => {
    expect(sameProcessKeySet(["2:b", "1:a"], ["1:a", "2:b"])).toBe(true);
    expect(sameProcessKeySet(["1:a"], ["1:a", "2:b"])).toBe(false);
    expect(sameProcessKeySet(["1:a"], ["1:b"])).toBe(false);
  });

  test("records activity when monitored process keys change", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const snapshots = [["1:root:0:0"], ["1:root:0:0"], ["1:root:1:0"], ["1:root:1:0", "2:child:0:0"], ["1:root:1:0"]];
    const activities: number[] = [];
    let index = 0;

    const stop = startProcessTreeActivityMonitor({
      intervalMs: 10,
      onActivity: () => activities.push(Date.now()),
      root,
      snapshotKeys: () => snapshots[Math.min(index++, snapshots.length - 1)]!,
    });

    vi.advanceTimersByTime(10);
    expect(activities).toEqual([]);
    vi.advanceTimersByTime(10);
    expect(activities).toEqual([20]);
    vi.advanceTimersByTime(10);
    expect(activities).toEqual([20, 30]);
    vi.advanceTimersByTime(10);
    expect(activities).toEqual([20, 30, 40]);
    stop();
  });

  test("does not poll after being stopped", () => {
    vi.useFakeTimers();
    let polls = 0;
    const stop = startProcessTreeActivityMonitor({ intervalMs: 10, onActivity: () => {}, root, snapshotKeys: () => [`1:${String(polls++)}`] });

    stop();
    vi.advanceTimersByTime(20);

    expect(polls).toBe(1);
  });

  test("does not reschedule when stopped during activity", () => {
    vi.useFakeTimers();
    const snapshots = [["1:root"], ["1:root", "2:child"], ["1:root", "3:child"]];
    let index = 0;
    let polls = 0;
    let stop = () => {};
    stop = startProcessTreeActivityMonitor({
      intervalMs: 10,
      onActivity: () => stop(),
      root,
      snapshotKeys: () => {
        polls += 1;
        return snapshots[Math.min(index++, snapshots.length - 1)]!;
      },
    });

    vi.advanceTimersByTime(30);

    expect(polls).toBe(2);
  });
});
