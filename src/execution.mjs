import { readFile } from "node:fs/promises";

import { defaultModel, defaultVariant, projectPaths, readJson, writeJson } from "./config.mjs";

export function validateExecution(execution) {
  const errors = [];

  if (execution?.version !== 1) errors.push("execution.version must be 1.");
  if (execution?.model !== defaultModel) errors.push(`execution.model must be ${defaultModel}.`);
  if (execution?.variant !== defaultVariant) errors.push(`execution.variant must be ${defaultVariant}.`);
  if (!Array.isArray(execution?.queue)) errors.push("execution.queue must be an array.");
  if (!Array.isArray(execution?.history)) errors.push("execution.history must be an array.");
  if (!Array.isArray(execution?.blocked)) errors.push("execution.blocked must be an array.");

  for (const [collection, records] of Object.entries({
    blocked: execution?.blocked ?? [],
    history: execution?.history ?? [],
    queue: execution?.queue ?? [],
  })) {
    for (const [index, step] of records.entries()) {
      validateStep(step, `${collection}[${index}]`, errors);
    }
  }

  return errors;
}

export async function validateGoals(projectRoot = process.cwd()) {
  const { goals } = projectPaths(projectRoot);
  const content = await readFile(goals, "utf8").catch(() => "");
  const errors = [];

  for (const required of ["goal", "Plan", "Execute", "Verify", "Commit", "Reconcile"]) {
    if (!content.toLowerCase().includes(required.toLowerCase())) {
      errors.push(`GOALS.md must mention ${required}.`);
    }
  }

  return errors;
}

export async function readExecution(projectRoot = process.cwd()) {
  return readJson(projectPaths(projectRoot).execution);
}

export async function writeExecution(execution, projectRoot = process.cwd()) {
  execution.updatedAt = new Date().toISOString();
  await writeJson(projectPaths(projectRoot).execution, execution);
}

export function nextStep(execution) {
  return execution.queue[0] ?? null;
}

export function formatStep(step) {
  if (!step) return "No queued step.";
  return [
    `${step.id} - ${step.title}`,
    `Phase: ${step.phase}`,
    `Scope: ${step.scope.join(", ")}`,
    `Acceptance: ${step.acceptance.join("; ")}`,
    `Commit: ${step.commitMessage}`,
  ].join("\n");
}

export function markDone(execution, stepId) {
  const step = execution.queue[0];
  if (!step || step.id !== stepId) throw new Error(`Can only complete queue[0], got ${stepId}.`);
  const [completed] = execution.queue.splice(0, 1);
  execution.history.push({ ...completed, completedAt: new Date().toISOString() });
}

export function markBlocked(execution, stepId, reason) {
  const step = execution.queue[0];
  if (!step || step.id !== stepId) throw new Error(`Can only block queue[0], got ${stepId}.`);
  const [blocked] = execution.queue.splice(0, 1);
  execution.blocked.push({ ...blocked, blockedAt: new Date().toISOString(), blockedReason: reason });
}

function validateStep(step, field, errors) {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(step?.id ?? "")) errors.push(`${field}.id must be kebab-case.`);
  for (const key of ["phase", "title", "prompt", "commitMessage"]) {
    if (typeof step?.[key] !== "string" || step[key].length === 0) errors.push(`${field}.${key} must be a non-empty string.`);
  }
  for (const key of ["scope", "acceptance", "verification"]) {
    if (!Array.isArray(step?.[key]) || step[key].length === 0) errors.push(`${field}.${key} must be a non-empty array.`);
  }
}
