import { readFile } from "node:fs/promises";
import path from "node:path";

import { defaultModel, defaultVariant, type ProjectContext } from "../infrastructure/config.js";

export interface QueueStep {
  acceptance: string[];
  blockedAt?: string;
  blockedReason?: string;
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
  history: QueueStep[];
  model: string;
  queue: QueueStep[];
  variant: string;
  version: 2;
}

export interface QueueValidationOptions {
  model?: string;
  variant?: string;
}

export function validateQueueFile(queueFile: unknown, { model = defaultModel, variant = defaultVariant }: QueueValidationOptions = {}): string[] {
  const errors: string[] = [];
  const value = queueFile as Partial<QueueFile> | null | undefined;

  if (value?.version !== 2) errors.push("queue.version must be 2.");
  if (value?.model !== model) errors.push(`queue.model must be ${model}.`);
  if (value?.variant !== variant) errors.push(`queue.variant must be ${variant}.`);
  if (!Array.isArray(value?.queue)) errors.push("queue.queue must be an array.");
  if (!Array.isArray(value?.history)) errors.push("queue.history must be an array.");
  if (!Array.isArray(value?.blocked)) errors.push("queue.blocked must be an array.");

  const seen = new Map<string, string>();

  for (const [collection, records] of Object.entries({
    queue: value?.queue ?? [],
    history: value?.history ?? [],
    blocked: value?.blocked ?? [],
  })) {
    if (!Array.isArray(records)) continue;
    for (const [index, step] of records.entries()) {
      const field = `${collection}[${index}]`;
      validateStep(step, field, errors);
      if (typeof step?.id !== "string" || step.id.length === 0) continue;

      const firstField = seen.get(step.id);
      if (firstField) errors.push(`${field}.id duplicates ${firstField}.id.`);
      else seen.set(step.id, field);
    }
  }

  return errors;
}

export async function validateGoals(context: ProjectContext): Promise<string[]> {
  let content = "";
  const label = goalsPathLabel(context);
  try {
    content = await readFile(context.paths.goals, "utf8");
  } catch {
    return [`${label} must exist.`];
  }

  return validateGoalsContent(context, content);
}

export function validateGoalsContent(context: ProjectContext, content: string): string[] {
  const label = goalsPathLabel(context);
  return content.trim().length === 0 ? [`${label} must not be empty.`] : [];
}

export function normalizeQueueFile(queueFile: QueueFile): QueueFile {
  return {
    version: queueFile.version,
    model: queueFile.model,
    variant: queueFile.variant,
    queue: queueFile.queue.map(normalizeStep),
    history: queueFile.history.map(normalizeStep),
    blocked: queueFile.blocked.map(normalizeStep),
  };
}

export function nextStep(queueFile: QueueFile): QueueStep | null {
  return queueFile.queue[0] ?? null;
}

export function formatStep(step: QueueStep | null): string {
  if (!step) return "No queued step.";
  return [
    `${step.id} - ${step.title}`,
    `Phase: ${step.phase}`,
    `Scope: ${step.scope.join(", ")}`,
    `Acceptance: ${step.acceptance.join("; ")}`,
  ].join("\n");
}

export function markDone(queueFile: QueueFile, stepId: string): void {
  const step = queueFile.queue[0];
  if (!step || step.id !== stepId) throw new Error(`Can only complete queue[0], got ${stepId}.`);
  const [completed] = queueFile.queue.splice(0, 1);
  queueFile.history.push({ ...completed!, completedAt: new Date().toISOString() });
}

export function markBlocked(queueFile: QueueFile, stepId: string, reason: string): void {
  const step = queueFile.queue[0];
  if (!step || step.id !== stepId) throw new Error(`Can only block queue[0], got ${stepId}.`);
  const [blocked] = queueFile.queue.splice(0, 1);
  queueFile.blocked.push({ ...blocked!, blockedAt: new Date().toISOString(), blockedReason: reason });
}

function validateStep(step: QueueStep, field: string, errors: string[]): void {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(step?.id ?? "")) errors.push(`${field}.id must be kebab-case.`);
  for (const key of ["phase", "title", "prompt"] as const) {
    if (typeof step?.[key] !== "string" || step[key].length === 0) errors.push(`${field}.${key} must be a non-empty string.`);
  }
  for (const key of ["scope", "acceptance", "verification"] as const) {
    if (!Array.isArray(step?.[key]) || step[key].length === 0) {
      errors.push(`${field}.${key} must be a non-empty array.`);
      continue;
    }

    for (const [index, item] of step[key].entries()) {
      if (typeof item !== "string" || item.length === 0) errors.push(`${field}.${key}[${index}] must be a non-empty string.`);
    }
  }
}

function normalizeStep(step: QueueStep): QueueStep {
  const normalized: QueueStep = {
    id: step.id,
    phase: step.phase,
    title: step.title,
    scope: [...step.scope],
    prompt: step.prompt,
    acceptance: [...step.acceptance],
    verification: [...step.verification],
  };
  if (step.completedAt !== undefined) normalized.completedAt = step.completedAt;
  if (step.blockedAt !== undefined) normalized.blockedAt = step.blockedAt;
  if (step.blockedReason !== undefined) normalized.blockedReason = step.blockedReason;
  return normalized;
}

export function goalsPathLabel(context: ProjectContext): string {
  const root = (context as Partial<ProjectContext>).root;
  if (!root) return path.basename(context.paths.goals);
  const relative = path.relative(root, context.paths.goals).split(path.sep).join(path.posix.sep);
  return relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative) ? relative : context.paths.goals;
}
