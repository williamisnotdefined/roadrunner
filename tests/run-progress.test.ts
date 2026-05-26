import { describe, expect, test } from "vitest";

import type { QueueStep } from "../src/domain/queue.js";
import { formatRunProgress, updateProgressForActivity, updateProgressForEvent, type RunProgressState } from "../src/ui/run-progress.js";

describe("run progress", () => {
  test("tracks active task phases and provider logs", () => {
    let progress: RunProgressState | null = null;

    progress = updateProgressForEvent(progress, { step, type: "step" }, 0);
    expect(progress).toMatchObject({ attempt: 1, phase: "plan", stepId: "sample-step" });

    progress = updateProgressForEvent(progress, { step, type: "implement" }, 1_000);
    expect(progress).toMatchObject({ lastActivityAt: 1_000, logPath: null, phase: "implement", phaseStartedAt: 1_000, pid: null });

    progress = updateProgressForEvent(progress, { command: ["opencode"], debug: false, logPath: "/tmp/implement.log", pid: 123, role: "implement", step, type: "provider-start" }, 2_000);
    expect(progress).toMatchObject({ lastActivityAt: 2_000, logPath: "/tmp/implement.log", pid: 123 });

    progress = updateProgressForActivity(progress, { phase: "implement", step }, 3_000);
    expect(progress?.lastActivityAt).toBe(3_000);
    expect(formatRunProgress(progress!, 4_000)).toContain("implement sample-step attempt=1 elapsed=4s phase=3s idle=1s pid=123 log=/tmp/implement.log");
    expect(formatRunProgress({ ...progress!, logPath: null, pid: null }, 4_000)).not.toContain("log=");
  });

  test("handles verify variants, restarts, cleanup, and unrelated events", () => {
    let progress: RunProgressState | null = updateProgressForEvent(null, { step, type: "step" }, 0);

    progress = updateProgressForEvent(progress, { attempt: "initial", step, type: "verify" }, 1_000);
    expect(progress?.phase).toBe("verify");
    progress = updateProgressForEvent(progress, { attempt: "fixed", step, type: "verify" }, 2_000);
    expect(progress?.phase).toBe("verify-fixed");

    progress = updateProgressForActivity(progress, { phase: "plan", step }, 3_000);
    expect(progress?.lastActivityAt).toBe(2_000);

    progress = updateProgressForEvent(progress, { attempt: 2, step, type: "task-restart" }, 4_000);
    expect(progress).toMatchObject({ attempt: 2, phase: "plan", taskStartedAt: 4_000 });

    const otherStep = { ...step, id: "other-step" };
    progress = updateProgressForEvent(progress, { command: ["opencode"], debug: false, logPath: "/tmp/other.log", pid: 456, role: "plan", step: otherStep, type: "provider-start" }, 5_000);
    expect(progress?.logPath).toBeNull();

    expect(updateProgressForEvent(null, { step, type: "implement" }, 6_000)).toBeNull();
    progress = updateProgressForEvent(progress, { step, type: "step-complete" }, 7_000);
    expect(progress).toBeNull();
    expect(updateProgressForEvent(updateProgressForEvent(null, { step, type: "step" }, 0), { type: "cleanup" }, 1_000)).toBeNull();
  });

  test("tracks startup refresh without a task step", () => {
    let progress: RunProgressState | null = updateProgressForEvent(null, { type: "startup-refresh" }, 0);

    expect(progress).toMatchObject({ phase: "startup-refresh", stepId: null });
    progress = updateProgressForActivity(progress, { phase: "startup-refresh" }, 1_000);
    expect(progress?.lastActivityAt).toBe(1_000);
    progress = updateProgressForEvent(progress, { command: ["opencode"], debug: false, logPath: "/tmp/startup.log", pid: null, role: "startup-refresh", type: "provider-start" }, 2_000);
    expect(formatRunProgress(progress!, 3_000)).toContain("startup-refresh attempt=1 elapsed=3s phase=3s idle=1s log=/tmp/startup.log");

    expect(updateProgressForActivity(null, { phase: "startup-refresh" }, 4_000)).toBeNull();
    expect(updateProgressForActivity(progress, { phase: "implement", step }, 5_000)?.lastActivityAt).toBe(2_000);
  });
});

const step: QueueStep = {
  acceptance: ["works"],
  id: "sample-step",
  phase: "Sample",
  prompt: "Build it.",
  scope: ["src/sample.ts"],
  title: "Ship Sample",
  verification: ["npm test"],
};
