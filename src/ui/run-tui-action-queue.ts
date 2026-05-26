import type { RunTuiAction } from "./run-tui-actions.js";

export interface RunTuiActionQueue {
  enqueue(action: RunTuiAction): void;
  wait(): Promise<RunTuiAction>;
}

export function createRunTuiActionQueue(): RunTuiActionQueue {
  const pending: RunTuiAction[] = [];
  const waiters: ((action: RunTuiAction) => void)[] = [];
  return {
    enqueue(action) {
      const waiter = waiters.shift();
      if (waiter) waiter(action);
      else pending.push(action);
    },
    wait() {
      const action = pending.shift();
      if (action) return Promise.resolve(action);
      return new Promise((resolve) => waiters.push(resolve));
    },
  };
}
