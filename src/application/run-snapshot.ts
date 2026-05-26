import { readFile } from "node:fs/promises";

import type { ProjectContext } from "../infrastructure/config.js";
import { goalsPathLabel, validateGoalsContent } from "../domain/queue.js";

export interface RunSnapshot {
  goalsMarkdown: string;
  operatorDirectiveMarkdown: string;
}

export async function readRunSnapshot(context: ProjectContext, options: { operatorDirective?: string | null } = {}): Promise<RunSnapshot> {
  let goalsMarkdown = "";
  try {
    goalsMarkdown = await readFile(context.paths.goals, "utf8");
  } catch {
    throw new Error(`${goalsPathLabel(context)} must exist. Create it or run roadrunner init.`);
  }

  const errors = validateGoalsContent(context, goalsMarkdown);
  if (errors.length > 0) throw new Error(errors.join("\n"));
  const operatorDirectiveMarkdown = options.operatorDirective?.trim() ? options.operatorDirective.trim() : "No active operator directive.";
  return { goalsMarkdown, operatorDirectiveMarkdown };
}
