import { type RestartableAttemptState, recordAttemptActivity } from "./auto-restart-watchdog.js";
import type { QueueStep } from "../domain/queue.js";
import type { ProviderStartEvent } from "../infrastructure/providers/index.js";
import { startProcessTreeActivityMonitor } from "../infrastructure/process-tree-activity.js";
import type { ProcessTreeRoot } from "../infrastructure/process-tree.js";
import type { RoadrunnerRunActivityEvent, RoadrunnerRunEvent, RoadrunnerRunPhase } from "./runner.js";

type StartProcessTreeActivityMonitor = (input: { intervalMs?: number; onActivity: () => void; root: ProcessTreeRoot }) => () => void;

interface AttemptActivityTrackerInput {
  current: RestartableAttemptState;
  emitActivity: (event: RoadrunnerRunActivityEvent) => void;
  emitEvent: (event: RoadrunnerRunEvent) => void;
  idleMs: number;
  startMonitor?: StartProcessTreeActivityMonitor;
  step: QueueStep;
}

export interface AttemptActivityTracker {
  recordProviderStart(event: ProviderStartEvent): void;
  setPhase(phase: RoadrunnerRunPhase): void;
  stop(): void;
}

export function createAttemptActivityTracker({ current, emitActivity, emitEvent, idleMs, startMonitor = startProcessTreeActivityMonitor, step }: AttemptActivityTrackerInput): AttemptActivityTracker {
  const intervalMs = idleMs > 0 ? Math.min(1_000, Math.max(100, Math.floor(idleMs / 2))) : 1_000;
  let stopProcessTreeActivityMonitor: (() => void) | null = null;

  const stop = () => {
    stopProcessTreeActivityMonitor?.();
    stopProcessTreeActivityMonitor = null;
    current.providerProcess = null;
  };

  return {
    recordProviderStart(event) {
      stop();
      current.providerProcess = event.processTreeRoot;
      recordAttemptActivity(current);
      emitEvent({ ...event, step, type: "provider-start" });
      if (event.processTreeRoot) {
        stopProcessTreeActivityMonitor = startMonitor({
          intervalMs,
          onActivity: () => {
            recordAttemptActivity(current);
            emitActivity({ phase: current.phase ?? "plan", step });
          },
          root: event.processTreeRoot,
        });
      }
    },
    setPhase(phase) {
      stop();
      current.phase = phase;
      recordAttemptActivity(current);
    },
    stop,
  };
}
