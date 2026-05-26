import type { Widgets } from "blessed";

export interface RunTuiKeyHandlers {
  cleanup(): void;
  confirmRestart(yes: boolean): void;
  directive(): void;
  down(): void;
  enter(): void;
  exit(): void;
  focusBack(): void;
  focusNext(): void;
  pageDown(): void;
  pageUp(): void;
  pauseOrPlay(): void;
  reconcile(): void;
  restart(): void;
  viewLogs(): void;
  up(): void;
}

export function bindRunTuiKeys(screen: Widgets.Screen, handlers: RunTuiKeyHandlers): void {
  screen.key(["tab"], handlers.focusNext);
  screen.key(["S-tab", "backtab"], handlers.focusBack);
  screen.key(["up", "k"], handlers.up);
  screen.key(["down", "j"], handlers.down);
  screen.key(["pageup"], handlers.pageUp);
  screen.key(["pagedown"], handlers.pageDown);
  screen.key(["enter"], handlers.enter);
  screen.key(["i"], handlers.directive);
  screen.key(["R"], handlers.reconcile);
  screen.key(["r"], handlers.restart);
  screen.key(["p", "space"], handlers.pauseOrPlay);
  screen.key(["c"], handlers.cleanup);
  screen.key(["q", "C-c", "C-q"], handlers.exit);
  screen.key(["l"], handlers.viewLogs);
  screen.key(["y", "Y"], () => handlers.confirmRestart(true));
  screen.key(["n", "N", "escape"], () => handlers.confirmRestart(false));
}
