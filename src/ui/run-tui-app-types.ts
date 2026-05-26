import type { Readable, Writable } from "node:stream";

import type { ProjectContext } from "../infrastructure/config.js";
import type { RoadrunnerRunActivityEvent, RoadrunnerRunControl, RoadrunnerRunEvent } from "../application/runner.js";
import type { RunSessionLogger } from "./run-session-log.js";
import type { RunTuiAction, RunTuiFailure } from "./run-tui-actions.js";

export interface RunTuiApp {
  onActivity(event: RoadrunnerRunActivityEvent): void;
  onControl(control: RoadrunnerRunControl): void;
  onEvent(event: RoadrunnerRunEvent): void;
  setStatus(status: string): void;
  showFailure(failure: RunTuiFailure): void;
  stop(): void;
  waitForAction(): Promise<RunTuiAction>;
}

export type RunTuiAppFactory = (context: ProjectContext, session: RunSessionLogger, options: { input: Readable; now: () => number; output: Writable }) => Promise<RunTuiApp>;
