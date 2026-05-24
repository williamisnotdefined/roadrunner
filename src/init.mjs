import { cp, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { defaultModel, defaultVariant, packageRoot, pathExists, projectPaths, writeJson } from "./config.mjs";

export async function initProject(projectRoot = process.cwd()) {
  const paths = projectPaths(projectRoot);
  const templateRoot = path.join(packageRoot, "templates");

  await mkdir(path.join(projectRoot, ".roadrunner"), { recursive: true });
  await mkdir(paths.prompts, { recursive: true });
  await mkdir(paths.logs, { recursive: true });

  if (!(await pathExists(paths.goals))) {
    await cp(path.join(templateRoot, "GOALS.md"), paths.goals);
  }

  if (!(await pathExists(paths.execution))) {
    await cp(path.join(templateRoot, "execution.json"), paths.execution);
  }

  if (!(await pathExists(paths.config))) {
    await writeJson(paths.config, {
      provider: "opencode",
      model: defaultModel,
      variant: defaultVariant,
    });
  }

  await cp(path.join(templateRoot, "prompts"), paths.prompts, { recursive: true });
  await writeFile(path.join(projectRoot, ".roadrunner/README.md"), "Roadrunner runtime state. Logs, locks, and process registries are local artifacts.\n");
}
