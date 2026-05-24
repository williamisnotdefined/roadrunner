import { readFile } from "node:fs/promises";

import { defaultModel, defaultVariant, type ProjectContext, readJson, writeJson } from "./config.js";

export interface QueueStep {
  acceptance: string[];
  blockedAt?: string;
  blockedReason?: string;
  commitMessage: string;
  completedAt?: string;
  id: string;
  phase: string;
  prompt: string;
  scope: string[];
  title: string;
  verification: string[];
}

export interface QueueFile {
  blocked: QueueStep[];
  goals?: string;
  history: QueueStep[];
  model: string;
  queue: QueueStep[];
  source?: string;
  updatedAt?: string | null;
  variant: string;
  version: 2;
}

export function validateQueueFile(queueFile: unknown): string[] {
  const errors: string[] = [];
  const value = queueFile as Partial<QueueFile> | null | undefined;

  if (value?.version !== 2) errors.push("queue.version must be 2.");
  if (value?.model !== defaultModel) errors.push(`queue.model must be ${defaultModel}.`);
  if (value?.variant !== defaultVariant) errors.push(`queue.variant must be ${defaultVariant}.`);
  if (!Array.isArray(value?.queue)) errors.push("queue.queue must be an array.");
  if (!Array.isArray(value?.history)) errors.push("queue.history must be an array.");
  if (!Array.isArray(value?.blocked)) errors.push("queue.blocked must be an array.");

  for (const [collection, records] of Object.entries({
    blocked: value?.blocked ?? [],
    history: value?.history ?? [],
    queue: value?.queue ?? [],
  })) {
    for (const [index, step] of records.entries()) validateStep(step, `${collection}[${index}]`, errors);
  }

  return errors;
}

export async function validateGoals(context: ProjectContext): Promise<string[]> {
  let content = "";
  try {
    content = await readFile(context.paths.goals, "utf8");
  } catch {
    return ["GOALS.md must exist."];
  }

  return content.trim().length === 0 ? ["GOALS.md must not be empty."] : [];
}

export async function readQueue(context: ProjectContext): Promise<QueueFile> {
  return readJson<QueueFile>(context.paths.queue);
}

export async function writeQueue(queueFile: QueueFile, context: ProjectContext): Promise<void> {
  queueFile.updatedAt = new Date().toISOString();
  await writeJson(context.paths.queue, queueFile);
}

export function nextStep(queueFile: QueueFile): QueueStep | null {
  return queueFile.queue[0] ?? null;
}

export function formatStep(step: QueueStep | null): string {
  if (!step) return "No queued step.";
  return [`${step.id} - ${step.title}`, `Phase: ${step.phase}`, `Scope: ${step.scope.join(", ")}`, `Acceptance: ${step.acceptance.join("; ")}`, `Commit: ${step.commitMessage}`].join("\n");
}

export function markDone(queueFile: QueueFile, stepId: string): void {
  const step = queueFile.queue[0];
  if (!step || step.id !== stepId) throw new Error(`Can only complete queue[0], got ${stepId}.`);
  const completed = queueFile.queue.shift();
  if (completed) queueFile.history.push({ ...completed, completedAt: new Date().toISOString() });
}

export function markBlocked(queueFile: QueueFile, stepId: string, reason: string): void {
  const step = queueFile.queue[0];
  if (!step || step.id !== stepId) throw new Error(`Can only block queue[0], got ${stepId}.`);
  const blocked = queueFile.queue.shift();
  if (blocked) queueFile.blocked.push({ ...blocked, blockedAt: new Date().toISOString(), blockedReason: reason });
}

function validateStep(step: QueueStep, field: string, errors: string[]): void {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(step?.id ?? "")) errors.push(`${field}.id must be kebab-case.`);
  for (const key of ["phase", "title", "prompt", "commitMessage"] as const) {
    if (typeof step?.[key] !== "string" || step[key].length === 0) errors.push(`${field}.${key} must be a non-empty string.`);
  }
  for (const key of ["scope", "acceptance", "verification"] as const) {
    if (!Array.isArray(step?.[key]) || step[key].length === 0) errors.push(`${field}.${key} must be a non-empty array.`);
  }
}
