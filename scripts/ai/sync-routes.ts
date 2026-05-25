#!/usr/bin/env node

import type { Dirent } from "node:fs";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

type ToolName = "opencode" | "cursor" | "github";

interface Registry {
  canonicalRoot: string;
  skills: Skill[];
  version: number;
}

interface Skill {
  canonicalPath: string;
  description: string;
  name: string;
  references: string[];
  routes: Record<ToolName, string>;
  toolConfig: {
    cursor: { alwaysApply: boolean; globs: string };
    github: { applyTo: string };
  };
}

interface SkillContext {
  canonical: string;
  references: Array<{ content: string; referencePath: string }>;
}

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.basename(path.resolve(scriptDir, "../..")) === "dist" ? path.resolve(scriptDir, "../../..") : path.resolve(scriptDir, "../..");
const checkOnly = process.argv.includes("--check");
const registry = JSON.parse(await readFile(path.join(rootDir, "ai/registry.json"), "utf8")) as Registry;
const notice = "Generated from `ai/registry.json`. Do not edit manually.";
const tools: ToolName[] = ["opencode", "cursor", "github"];

const errors = validateRegistry(registry);
if (errors.length > 0) {
  console.error(errors.map((error) => `- ${error}`).join("\n"));
  process.exit(1);
}

const expectedRoutes = new Map<string, string>();

for (const skill of registry.skills) {
  const context = await readContext(skill);
  for (const tool of tools) {
    const routePath = skill.routes[tool];
    expectedRoutes.set(routePath, renderRoute(tool, skill, context));
  }
}

const stale: string[] = [];
for (const [routePath, content] of expectedRoutes) {
  const absolutePath = path.join(rootDir, routePath);
  const current = await readOptional(absolutePath);

  if (current === content) continue;
  if (checkOnly) stale.push(routePath);
  else {
    await mkdir(path.dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, content);
  }
}

for (const orphan of await generatedRouteFiles()) {
  if (expectedRoutes.has(orphan)) continue;
  if (checkOnly) stale.push(orphan);
  else await rm(path.join(rootDir, orphan), { force: true });
}

if (stale.length > 0) {
  console.error(`AI routes are out of sync. Run npm run ai:sync. Stale: ${stale.join(", ")}`);
  process.exit(1);
}

console.log(`AI routes ${checkOnly ? "checked" : "synced"}: ${registry.skills.length} skills.`);

function validateRegistry(value: Registry): string[] {
  const errors: string[] = [];
  if (value.version !== 1) errors.push("registry.version must be 1.");
  if (value.canonicalRoot !== "ai/skills") errors.push("registry.canonicalRoot must be ai/skills.");
  if (!Array.isArray(value.skills)) errors.push("registry.skills must be an array.");

  const seen = new Set<string>();
  for (const skill of value.skills ?? []) {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(skill.name ?? "")) errors.push(`${skill.name}: invalid skill name.`);
    if (seen.has(skill.name)) errors.push(`${skill.name}: duplicate skill.`);
    seen.add(skill.name);
    for (const reference of skill.references ?? []) {
      if (!reference.startsWith("ai/")) errors.push(`${skill.name}: invalid reference ${reference}.`);
    }
    for (const tool of tools) {
      if (!skill.routes?.[tool]) errors.push(`${skill.name}: missing ${tool} route.`);
    }
  }
  return errors;
}

async function readContext(skill: Skill): Promise<SkillContext> {
  return {
    canonical: await readFile(path.join(rootDir, skill.canonicalPath), "utf8"),
    references: await Promise.all(
      skill.references.map(async (referencePath) => ({
        content: await readFile(path.join(rootDir, referencePath), "utf8"),
        referencePath,
      })),
    ),
  };
}

function renderRoute(tool: ToolName, skill: Skill, context: SkillContext): string {
  const body = `${notice}\n\n# ${skill.name}\n\n${context.canonical.trim()}\n\n# Referenced Context\n\n${context.references
    .map((reference) => `## ${reference.referencePath}\n\n${reference.content.trim()}`)
    .join("\n\n")}\n`;

  if (tool === "opencode") return `---\nname: ${skill.name}\ndescription: ${JSON.stringify(skill.description)}\n---\n\n${body}`;
  if (tool === "cursor") {
    return `---\ndescription: ${JSON.stringify(skill.description)}\nglobs: ${JSON.stringify(skill.toolConfig.cursor.globs)}\nalwaysApply: ${skill.toolConfig.cursor.alwaysApply ? "true" : "false"}\n---\n\n${body}`;
  }
  return `---\napplyTo: ${JSON.stringify(skill.toolConfig.github.applyTo)}\n---\n\n${body}`;
}

async function readOptional(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, "utf8");
  } catch {
    return null;
  }
}

async function generatedRouteFiles(): Promise<string[]> {
  const files: string[] = [];
  for (const root of [".opencode/skills", ".cursor/rules", ".github/instructions"]) {
    for (const file of await listFiles(root)) {
      const content = await readOptional(path.join(rootDir, file));
      if (content?.includes(notice)) files.push(file);
    }
  }
  return files;
}

async function listFiles(relativeDirectory: string): Promise<string[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(path.join(rootDir, relativeDirectory), { withFileTypes: true });
  } catch {
    return [];
  }

  const files: string[] = [];
  for (const entry of entries) {
    const entryPath = path.posix.join(relativeDirectory, entry.name);
    if (entry.isDirectory()) files.push(...(await listFiles(entryPath)));
    if (entry.isFile()) files.push(entryPath);
  }
  return files;
}
