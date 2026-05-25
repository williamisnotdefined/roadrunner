import { readFile } from "node:fs/promises";

import type { ProjectContext } from "./config.js";
import { goalsPathLabel, validateGoalsContent } from "./queue.js";

export interface RunSnapshot {
  goalsMarkdown: string;
}

export async function readRunSnapshot(context: ProjectContext): Promise<RunSnapshot> {
  let goalsMarkdown = "";
  try {
    goalsMarkdown = await readFile(context.paths.goals, "utf8");
  } catch {
    throw new Error(`${goalsPathLabel(context)} must exist.`);
  }

  const errors = validateGoalsContent(context, goalsMarkdown);
  if (errors.length > 0) throw new Error(errors.join("\n"));
  return { goalsMarkdown };
}
