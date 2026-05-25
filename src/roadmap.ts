import { readFile } from "node:fs/promises";

import { defaultModel, defaultVariant, pathExists, type ProjectContext } from "./config.js";
import { acquireProjectLock } from "./lock.js";
import { normalizeQueueFile, readQueue, validateQueueFile, writeQueue, type QueueFile, type QueueStep } from "./queue.js";

interface RoadmapSection {
  body: string[];
  id: string;
  line: number;
  title: string;
}

interface RoadmapOptions {
  model?: string;
  variant?: string;
}

const fieldAliases: ReadonlyMap<string, string> = new Map([
  ["phase", "phase"],
  ["scope", "scope"],
  ["prompt", "prompt"],
  ["acceptance", "acceptance"],
  ["verification", "verification"],
]);

export async function importRoadmap(context: ProjectContext): Promise<QueueFile> {
  const releaseLock = await acquireProjectLock(context, "Roadrunner import-roadmap");
  try {
    const parsed = await queueFileFromRoadmapFile(context);
    const existingRaw = (await pathExists(context.paths.queue)) ? await readQueue(context) : null;
    if (existingRaw) {
      const errors = validateQueueFile(existingRaw, { model: context.config.model, variant: context.config.variant });
      if (errors.length > 0) throw new Error(errors.join("\n"));
    }
    const existing = existingRaw ? normalizeQueueFile(existingRaw) : null;

    const queueFile = mergeQueueState(parsed, existing);
    const errors = validateQueueFile(queueFile, { model: context.config.model, variant: context.config.variant });
    if (errors.length > 0) throw new Error(errors.join("\n"));

    await writeQueue(queueFile, context);
    return queueFile;
  } finally {
    await releaseLock();
  }
}

export async function queueFileFromRoadmapFile(context: ProjectContext): Promise<QueueFile> {
  const markdown = await readFile(context.paths.roadmap, "utf8");
  return queueFileFromRoadmap(markdown, {
    model: context.config.model,
    variant: context.config.variant,
  });
}

export function queueFileFromRoadmap(markdown: string, options: RoadmapOptions): QueueFile {
  const errors: string[] = [];
  const sections = roadmapSections(markdown);
  const steps = sections.map((section) => stepFromSection(section, errors));
  const seen = new Set<string>();

  for (const step of steps) {
    if (seen.has(step.id)) errors.push(`${step.id}: duplicate roadmap step id.`);
    seen.add(step.id);
  }

  if (sections.length === 0) errors.push("Roadmap must contain at least one step heading like '## first-step: First step'.");
  if (errors.length > 0) throw new Error(errors.join("\n"));

  const queueFile: QueueFile = {
    version: 2,
    model: options.model ?? defaultModel,
    variant: options.variant ?? defaultVariant,
    queue: steps,
    history: [],
    blocked: [],
  };

  const validationErrors = validateQueueFile(queueFile, { model: queueFile.model, variant: queueFile.variant });
  if (validationErrors.length > 0) throw new Error(validationErrors.join("\n"));

  return queueFile;
}

function mergeQueueState(parsed: QueueFile, existing: QueueFile | null): QueueFile {
  if (!existing) return parsed;

  const closed = new Set([...existing.history, ...existing.blocked].map((step) => step.id));
  const importedOpen = parsed.queue.filter((step) => !closed.has(step.id));
  return {
    ...parsed,
    queue: importedOpen,
    history: existing.history,
    blocked: existing.blocked,
  };
}

function roadmapSections(markdown: string): RoadmapSection[] {
  const sections: RoadmapSection[] = [];
  let current: RoadmapSection | null = null;
  const lines = markdown.replaceAll("\r\n", "\n").split("\n");

  for (const [index, line] of lines.entries()) {
    const heading = /^#{2,6}\s+(.+?)\s*$/.exec(line);
    const stepHeading = heading ? parseStepHeading(heading[1]!) : null;

    if (stepHeading) {
      if (current) sections.push(current);
      current = { ...stepHeading, body: [], line: index + 1 };
      continue;
    }

    if (current) current.body.push(line);
  }

  if (current) sections.push(current);
  return sections;
}

function parseStepHeading(value: string): { id: string; title: string } | null {
  const plain = /^([a-z0-9]+(?:-[a-z0-9]+)*)(?::|\s+-\s+)\s*(.+)$/.exec(value);
  if (plain) return { id: plain[1]!, title: plain[2]!.trim() };

  const bracketed = /^\[([a-z0-9]+(?:-[a-z0-9]+)*)\]\s+(.+)$/.exec(value);
  if (bracketed) return { id: bracketed[1]!, title: bracketed[2]!.trim() };

  return null;
}

function stepFromSection(section: RoadmapSection, errors: string[]): QueueStep {
  const fields = parseFields(section.body);
  const step: QueueStep = {
    id: section.id,
    title: section.title,
    phase: textField(fields, "phase", section, errors),
    scope: listField(fields, "scope", section, errors, { commaSeparated: true }),
    prompt: textField(fields, "prompt", section, errors, { multiline: true }),
    acceptance: listField(fields, "acceptance", section, errors),
    verification: listField(fields, "verification", section, errors),
  };

  return step;
}

function parseFields(lines: string[]): Map<string, string[]> {
  const fields = new Map<string, string[]>();
  let current: string | null = null;

  for (const line of lines) {
    const match = /^\s{0,3}([A-Za-z][A-Za-z0-9 -]*):\s*(.*)$/.exec(line);
    const alias = match ? fieldAliases.get(match[1]!.trim().toLowerCase()) : undefined;

    if (match && !alias) {
      if (current === "prompt") fields.get(current)?.push(line);
      else current = null;
      continue;
    }

    if (alias) {
      current = alias;
      if (!fields.has(current)) fields.set(current, []);
      const rest = match![2]!;
      if (rest.length > 0) fields.get(current)?.push(rest);
      continue;
    }

    if (current) fields.get(current)?.push(line);
  }

  return fields;
}

function textField(fields: Map<string, string[]>, name: string, section: RoadmapSection, errors: string[], { multiline = false } = {}): string {
  const value = (fields.get(name) ?? [])
    .map((line) => line.trimEnd())
    .join("\n")
    .trim();
  if (value.length === 0) errors.push(`${section.id}: missing ${name} field near line ${section.line}.`);
  return multiline ? value : value.replace(/\s+/g, " ");
}

function listField(fields: Map<string, string[]>, name: string, section: RoadmapSection, errors: string[], { commaSeparated = false } = {}): string[] {
  const raw = fields.get(name) ?? [];
  const items: string[] = [];
  const meaningful = raw.map((line) => line.trim()).filter((line) => line.length > 0);

  for (const line of meaningful) {
    const bullet = /^(?:[-*]|\d+[.)])\s+(.+)$/.exec(line);
    const value = (bullet?.[1] ?? line).trim();

    if (commaSeparated && !bullet && meaningful.length === 1) {
      items.push(
        ...value
          .split(",")
          .map((item) => item.trim())
          .filter((item) => item.length > 0),
      );
    } else {
      items.push(value);
    }
  }

  if (items.length === 0) errors.push(`${section.id}: missing ${name} field near line ${section.line}.`);
  return items;
}
