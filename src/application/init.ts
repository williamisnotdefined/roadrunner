import { cp, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { defaultModel, defaultVariant, packageRoot, pathExists, type ProjectContext, writeJson } from "../infrastructure/config.js";
import { upsertRoadrunnerGitignore } from "../infrastructure/gitignore.js";

export async function initProject(context: ProjectContext): Promise<void> {
  const templateRoot = path.join(packageRoot, "templates");

  await mkdir(path.dirname(context.paths.config), { recursive: true });
  await mkdir(path.dirname(context.paths.goals), { recursive: true });
  await mkdir(context.paths.prompts, { recursive: true });
  await mkdir(context.paths.logs, { recursive: true });

  if (!(await pathExists(context.paths.goals))) await cp(path.join(templateRoot, "GOALS.md"), context.paths.goals);
  if (!(await pathExists(context.paths.config))) {
    await writeJson(context.paths.config, {
      allowNestedOpenCode: false,
      allowedVerificationCommands: [],
      autoRestartIdleMs: context.config.autoRestartIdleMs,
      dangerouslySkipPermissions: false,
      maxAutoRestartsPerStep: context.config.maxAutoRestartsPerStep,
      provider: "opencode",
      model: defaultModel,
      variant: defaultVariant,
      paths: {
        goals: relativeToRoot(context, context.paths.goals),
        lock: relativeToRoot(context, context.paths.lock),
        logs: relativeToRoot(context, context.paths.logs),
        processes: relativeToRoot(context, context.paths.processRegistry),
        prompts: relativeToRoot(context, context.paths.prompts),
        roadmap: relativeToRoot(context, context.paths.roadmap),
      },
    });
  }

  await cp(path.join(templateRoot, "prompts"), context.paths.prompts, { force: false, recursive: true });
  await ensureRuntimeGitignore(context);
  await writeRuntimeReadme(context);
}

async function writeRuntimeReadme(context: ProjectContext): Promise<void> {
  const configDir = path.dirname(context.paths.config);
  if (path.resolve(configDir) === path.resolve(context.root)) return;

  const readmePath = path.join(configDir, "README.md");
  if (!(await pathExists(readmePath))) await writeFile(readmePath, "Roadrunner runtime state. Logs, locks, and process registries are local artifacts.\n");
}

async function ensureRuntimeGitignore(context: ProjectContext): Promise<void> {
  const configDir = path.dirname(context.paths.config);
  const runtimePaths = [
    { directory: true, path: context.paths.logs },
    { directory: false, path: context.paths.processRegistry },
    { directory: false, path: context.paths.lock },
  ];
  const configEntries = runtimePaths.flatMap((runtimePath) => gitignoreEntry(configDir, runtimePath.path, runtimePath.directory) ?? []);
  await upsertRoadrunnerGitignore(path.join(configDir, ".gitignore"), configEntries);

  const outsideConfigDir = runtimePaths.some((runtimePath) => !isInside(configDir, runtimePath.path));
  if (outsideConfigDir) {
    const rootEntries = runtimePaths.flatMap((runtimePath) => gitignoreEntry(context.root, runtimePath.path, runtimePath.directory) ?? []);
    await upsertRoadrunnerGitignore(path.join(context.root, ".gitignore"), rootEntries);
  }
}

function gitignoreEntry(baseDir: string, filePath: string, directory: boolean): string | null {
  const relative = path.relative(baseDir, filePath).split(path.sep).join(path.posix.sep);
  if (relative.length === 0 || relative.startsWith("../") || path.isAbsolute(relative)) return null;
  return directory ? `${relative.replace(/\/$/, "")}/` : relative;
}

function isInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function relativeToRoot(context: ProjectContext, filePath: string): string {
  return path.relative(context.root, filePath) || ".";
}
