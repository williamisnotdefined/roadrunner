import { describe, expect, test } from "vitest";

import { createRunTuiActionQueue } from "../src/ui/run-tui-action-queue.js";
import { setFocusBorders, type RunTuiElements } from "../src/ui/run-tui-elements.js";
import { bindRunTuiKeys } from "../src/ui/run-tui-keymap.js";
import { actionText, createDisplayState, currentDisplayState, failureActionText, logViewerText, renderFailureModal } from "../src/ui/run-tui-view.js";

describe("run TUI UI helpers", () => {
  test("queues TUI actions before and after waiters", async () => {
    const queue = createRunTuiActionQueue();
    queue.enqueue({ type: "play" });
    await expect(queue.wait()).resolves.toEqual({ type: "play" });

    const waiting = queue.wait();
    queue.enqueue({ type: "exit" });
    await expect(waiting).resolves.toEqual({ type: "exit" });
  });

  test("updates focus borders for each panel", () => {
    const elements = fakeElements();
    setFocusBorders(elements, "tasks");
    expect(elements.table.style.border).toEqual({ fg: "cyan" });
    setFocusBorders(elements, "logs");
    expect(elements.logs.style.border).toEqual({ fg: "cyan" });
    setFocusBorders(elements, "log");
    expect(elements.log.style.border).toEqual({ fg: "cyan" });
  });

  test("formats failure modal, actions, logs, and display states", () => {
    const failure = { details: ["Task: sample", "Phase: plan"], message: "idle", recoverable: true, title: "Auto restart" };
    const modal = fakeModal();
    renderFailureModal(modal, failure);
    expect(modal.visible).toBe(true);
    expect(modal.content).toContain("Auto restart");
    expect(modal.content).toContain("[Enter/Esc] Close");
    renderFailureModal(modal, null);
    expect(modal.visible).toBe(false);

    expect(failureActionText(null)).toBeNull();
    expect(failureActionText({ ...failure, details: [] })).toContain("Restart task");
    expect(failureActionText({ ...failure, details: [] })).toContain("[Enter/Esc] Close");
    expect(logViewerText(null, "")).toContain("Select a task log");
    expect(logViewerText({ label: "provider", relativePath: "provider.log" }, "")).toContain("Waiting for provider output");
    expect(actionText(null, false, false)).toContain("Play");
    expect(actionText(null, false, true)).toContain("Stopping");

    const base = createDisplayState("IDLE", "idle", null, 1000);
    expect(currentDisplayState({ baseDisplay: { ...base, status: "DONE" }, now: 2000, progress: null, row: null, status: "done", stopping: false }).status).toBe("DONE");
    expect(currentDisplayState({ baseDisplay: base, now: 2000, progress: null, row: null, status: "stop", stopping: true }).status).toBe("STOPPING");
    expect(currentDisplayState({ baseDisplay: base, now: 2000, progress: { attempt: 1, lastActivityAt: 1000, logPath: null, phase: "plan", phaseStartedAt: 1000, pid: null, stepId: "sample", taskStartedAt: 1000 }, row: null, status: "", stopping: false }).status).toBe("PLANNING");
  });

  test("binds Escape to modal cancel instead of restart decline", () => {
    const calls: string[] = [];
    const screen = fakeScreen();

    bindRunTuiKeys(screen as never, {
      cancel: () => calls.push("cancel"),
      cleanup: () => calls.push("cleanup"),
      confirmRestart: (yes) => calls.push(`confirm:${String(yes)}`),
      directive: () => calls.push("directive"),
      down: () => calls.push("down"),
      enter: () => calls.push("enter"),
      exit: () => calls.push("exit"),
      focusBack: () => calls.push("focusBack"),
      focusNext: () => calls.push("focusNext"),
      pageDown: () => calls.push("pageDown"),
      pageUp: () => calls.push("pageUp"),
      pauseOrPlay: () => calls.push("pauseOrPlay"),
      reconcile: () => calls.push("reconcile"),
      restart: () => calls.push("restart"),
      up: () => calls.push("up"),
      viewLogs: () => calls.push("viewLogs"),
    });

    screen.handlers.escape?.();
    screen.handlers.n?.();

    expect(calls).toEqual(["cancel", "confirm:false"]);
  });
});

function fakeElements(): RunTuiElements {
  const box = () => ({ style: {} }) as never;
  return { actions: box(), details: box(), footer: box(), header: box(), log: box(), logs: box(), modal: box(), screen: box(), table: box() };
}

function fakeModal() {
  return {
    content: "",
    visible: true,
    hide() {
      this.visible = false;
    },
    setContent(content: string) {
      this.content = content;
    },
    show() {
      this.visible = true;
    },
  };
}

function fakeScreen() {
  const handlers: Record<string, () => void> = {};
  return {
    handlers,
    key(keys: string[], handler: () => void) {
      for (const key of keys) handlers[key] = handler;
    },
  } as never as { handlers: Record<string, () => void>; key(keys: string[], handler: () => void): void };
}
