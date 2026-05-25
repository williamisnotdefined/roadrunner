import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { defaultModel, defaultVariant, packageRoot, pathExists, type ProjectContext, writeJson } from "./config.js";
import { writeQueue, type QueueFile } from "./queue.js";
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
    else await writeQueue(await defaultQueueFile(context, templateRoot), context);
  }
  if (!(await pathExists(context.paths.config))) {
    await writeJson(context.paths.config, {
      allowNestedOpenCode: false,
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
        queue: relativeToRoot(context, context.paths.queue),
        roadmap: relativeToRoot(context, context.paths.roadmap),
      },
    });
  }

  await cp(path.join(templateRoot, "prompts"), context.paths.prompts, { force: false, recursive: true });
  await ensureRuntimeGitignore(context);
  await writeRuntimeReadme(context);
}

async function defaultQueueFile(context: ProjectContext, templateRoot: string): Promise<QueueFile> {
  const queueFile = JSON.parse(await readFile(path.join(templateRoot, "queue.json"), "utf8")) as QueueFile;
  return {
    ...queueFile,
    model: context.config.model,
    variant: context.config.variant,
  };
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
  await upsertGitignoreBlock(path.join(configDir, ".gitignore"), configEntries);

  const outsideConfigDir = runtimePaths.some((runtimePath) => !isInside(configDir, runtimePath.path));
  if (outsideConfigDir) {
    const rootEntries = runtimePaths.flatMap((runtimePath) => gitignoreEntry(context.root, runtimePath.path, runtimePath.directory) ?? []);
    await upsertGitignoreBlock(path.join(context.root, ".gitignore"), rootEntries);
  }
}

async function upsertGitignoreBlock(filePath: string, entries: string[]): Promise<void> {
  if (entries.length === 0) return;
  const blockStart = "# Roadrunner runtime";
  const blockEnd = "# End Roadrunner runtime";
  const block = `${blockStart}\n${[...new Set(entries)].join("\n")}\n${blockEnd}\n`;
  const current = (await pathExists(filePath)) ? await readFile(filePath, "utf8") : "";
  const pattern = new RegExp(`${escapeRegExp(blockStart)}\\n[\\s\\S]*?${escapeRegExp(blockEnd)}\\n?`);
  const next = pattern.test(current)
    ? current.replace(pattern, block)
    : `${current}${current.length > 0 && !current.endsWith("\n") ? "\n" : ""}${current.length > 0 ? "\n" : ""}${block}`;
  await writeFile(filePath, next);
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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function relativeToRoot(context: ProjectContext, filePath: string): string {
  return path.relative(context.root, filePath) || ".";
}
