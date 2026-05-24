import { cp, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { defaultModel, defaultVariant, packageRoot, pathExists, type ProjectContext, writeJson } from "./config.js";
import { writeQueue } from "./queue.js";
import { queueFileFromRoadmapFile } from "./roadmap.js";

export async function initProject(context: ProjectContext): Promise<void> {
  const templateRoot = path.join(packageRoot, "templates");

  await mkdir(path.dirname(context.paths.config), { recursive: true });
  await mkdir(path.dirname(context.paths.goals), { recursive: true });
  await mkdir(context.paths.prompts, { recursive: true });
  await mkdir(context.paths.logs, { recursive: true });
  await mkdir(path.dirname(context.paths.queue), { recursive: true });

  if (!(await pathExists(context.paths.goals))) await cp(path.join(templateRoot, "GOALS.md"), context.paths.goals);
  if (!(await pathExists(context.paths.queue))) {
    if (await pathExists(context.paths.roadmap)) await writeQueue(await queueFileFromRoadmapFile(context), context);
    else await cp(path.join(templateRoot, "queue.json"), context.paths.queue);
  }
  if (!(await pathExists(context.paths.config))) {
    await writeJson(context.paths.config, {
      allowNestedOpenCode: false,
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
        roadmap: relativeToRoot(context, context.paths.roadmap),
      },
    });
  }

  await cp(path.join(templateRoot, "prompts"), context.paths.prompts, { force: false, recursive: true });
  const runtimeGitignore = path.join(path.dirname(context.paths.config), ".gitignore");
  if (!(await pathExists(runtimeGitignore))) await writeFile(runtimeGitignore, "logs/\nprocesses.json\nroadmap.lock\n");
  await writeFile(path.join(path.dirname(context.paths.config), "README.md"), "Roadrunner runtime state. Logs, locks, and process registries are local artifacts.\n");
}

function relativeToRoot(context: ProjectContext, filePath: string): string {
  /* v8 ignore next -- init destinations are file paths, not the project root itself. */
  return path.relative(context.root, filePath) || ".";
}
