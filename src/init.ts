import { cp, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { defaultModel, defaultVariant, packageRoot, pathExists, type ProjectContext, writeJson } from "./config.js";

export async function initProject(context: ProjectContext): Promise<void> {
  const templateRoot = path.join(packageRoot, "templates");

  await mkdir(path.dirname(context.paths.config), { recursive: true });
  await mkdir(context.paths.prompts, { recursive: true });
  await mkdir(context.paths.logs, { recursive: true });

  if (!(await pathExists(context.paths.goals))) await cp(path.join(templateRoot, "GOALS.md"), context.paths.goals);
  if (!(await pathExists(context.paths.queue))) await cp(path.join(templateRoot, "queue.json"), context.paths.queue);
  if (!(await pathExists(context.paths.config))) {
    await writeJson(context.paths.config, {
      provider: "opencode",
      model: defaultModel,
      variant: defaultVariant,
      paths: {
        goals: relativeToRoot(context, context.paths.goals),
        lock: relativeToRoot(context, context.paths.lock),
        logs: relativeToRoot(context, context.paths.logs),
        processes: relativeToRoot(context, context.paths.processRegistry),
        prompts: relativeToRoot(context, context.paths.prompts),
        queue: relativeToRoot(context, context.paths.queue),
      },
    });
  }

  await cp(path.join(templateRoot, "prompts"), context.paths.prompts, { recursive: true });
  await writeFile(path.join(path.dirname(context.paths.config), "README.md"), "Roadrunner runtime state. Logs, locks, and process registries are local artifacts.\n");
}

function relativeToRoot(context: ProjectContext, filePath: string): string {
  return path.relative(context.root, filePath) || ".";
}
