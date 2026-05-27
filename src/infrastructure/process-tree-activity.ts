import { processTreeActivityKeys, type ProcessTreeRoot } from "./process-tree.js";

interface ProcessTreeActivityMonitorInput {
  intervalMs?: number;
  onActivity: () => void;
  root: ProcessTreeRoot;
  snapshotKeys?: (root: ProcessTreeRoot) => readonly string[];
}

export function startProcessTreeActivityMonitor({ intervalMs = 1_000, onActivity, root, snapshotKeys = processTreeActivityKeys }: ProcessTreeActivityMonitorInput): () => void {
  let stopped = false;
  let previous = snapshotKeys(root);
  let timeout: NodeJS.Timeout | undefined;

  const check = () => {
    /* v8 ignore next -- timeout callbacks can race with stop in real runtimes. */
    if (stopped) return;
    const next = snapshotKeys(root);
    if (!sameProcessKeySet(previous, next)) {
      previous = next;
      onActivity();
    }
    if (stopped) return;
    timeout = setTimeout(check, Math.max(1, intervalMs));
  };

  timeout = setTimeout(check, Math.max(1, intervalMs));
  return () => {
    stopped = true;
    clearTimeout(timeout);
  };
}

export function sameProcessKeySet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const normalizedLeft = [...left].sort();
  const normalizedRight = [...right].sort();
  return normalizedLeft.every((value, index) => value === normalizedRight[index]);
}
