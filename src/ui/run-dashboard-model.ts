import type { QueueFile, QueueStep } from "../domain/queue.js";
import { escapeBlessedMarkup } from "./blessed-markup.js";

export type TaskRowStatus = "blocked" | "current" | "done" | "next";

export interface TaskRow {
  icon: string;
  id: string;
  phase: string;
  status: TaskRowStatus;
  statusLabel: string;
  step: QueueStep;
  title: string;
}

export interface TaskStats {
  blocked: number;
  current: number;
  done: number;
  next: number;
}

const labels: Record<TaskRowStatus, { icon: string; label: string }> = {
  blocked: { icon: "!", label: "Blocked" },
  current: { icon: "▶", label: "Active" },
  done: { icon: "✓", label: "Done" },
  next: { icon: "·", label: "Waiting" },
};

export function taskRowsFromQueue(queueFile: QueueFile): TaskRow[] {
  return [
    ...queueFile.queue.slice(0, 1).map((step) => taskRow(step, "current")),
    ...queueFile.queue.slice(1).map((step) => taskRow(step, "next")),
    ...queueFile.blocked.map((step) => taskRow(step, "blocked")),
  ];
}

export function taskStats(queueFile: QueueFile): TaskStats {
  return {
    blocked: queueFile.blocked.length,
    current: queueFile.queue.length > 0 ? 1 : 0,
    done: queueFile.history.length,
    next: Math.max(0, queueFile.queue.length - 1),
  };
}

export function selectedTaskIndex(rows: TaskRow[], selectedTaskId: string | null): number {
  if (rows.length === 0) return -1;
  const selected = selectedTaskId ? rows.findIndex((row) => row.id === selectedTaskId) : -1;
  if (selected >= 0) return selected;
  const current = rows.findIndex((row) => row.status === "current");
  return current >= 0 ? current : 0;
}

export function taskTableData(rows: TaskRow[], selectedTaskId: string | null, stats?: TaskStats): string[][] {
  const selectedIndex = selectedTaskIndex(rows, selectedTaskId);
  const data = [
    ["Status", "ID", "Phase", "Title"],
    ...rows.map((row, index) => {
      const marker = index === selectedIndex ? "›" : " ";
      return [
        `${marker} ${escapeBlessedMarkup(row.icon)} ${escapeBlessedMarkup(row.statusLabel)}`,
        escapeBlessedMarkup(row.id),
        escapeBlessedMarkup(row.phase),
        escapeBlessedMarkup(row.title),
      ];
    }),
  ];
  if (stats && stats.done > 0) data.push(["", "", "", `${stats.done} completed hidden`]);
  return data;
}

function taskRow(step: QueueStep, status: TaskRowStatus): TaskRow {
  return {
    icon: labels[status].icon,
    id: step.id,
    phase: step.phase,
    status,
    statusLabel: labels[status].label,
    step,
    title: step.title,
  };
}
