import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import type { Stats } from "node:fs";
import { lstat, readFile, readdir, readlink } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import type { ProjectContext } from "./config.js";

export interface StatusEntry {
  path: string;
  status: string;
}

export interface ProjectMutationFingerprintOptions {
  includeIgnoredFiles?: boolean;
  ignoredPaths?: string[];
}

const execFileAsync = promisify(execFile);
const fallbackFingerprintIgnoredDirectories = new Set([".git", "coverage", "dist", "node_modules", "test-output"]);

export async function projectMutationFingerprint(context: ProjectContext, options: ProjectMutationFingerprintOptions = {}): Promise<string | null> {
  const ignoredPaths = normalizedIgnoredPaths(context, options.ignoredPaths ?? []);
  const statusOutput = await gitStatusOutput(context, options.includeIgnoredFiles ?? false);
  if (statusOutput === null) return filesystemMutationFingerprint(context, ignoredPaths);

  const entries = parseStatusEntries(statusOutput).filter(
    (entry) => !isRoadrunnerRuntimePath(context, entry.path) && !isIgnoredRelativePath(entry.path, ignoredPaths) && !isExcludedIgnoredStatusPath(context, entry),
  );
  const head = await gitHead(context);
  const fingerprints = await Promise.all(
    entries.map(async (entry) => ({
      path: entry.path,
      status: entry.status,
      content: await fileFingerprint(path.resolve(context.root, entry.path)),
    })),
  );

  return JSON.stringify({ head, fingerprints });
}

export function parseStatusPaths(output: string): string[] {
  return parseStatusEntries(output).map((entry) => entry.path);
}

export function parseStatusEntries(output: string): StatusEntry[] {
  if (output.includes("\0")) {
    const records = output.split("\0").filter((record) => record.length > 0);
    const entries: StatusEntry[] = [];

    for (let index = 0; index < records.length; index += 1) {
      const record = records[index]!;
      const status = record.slice(0, 2);
      entries.push({ path: record.slice(3), status });
      if (status.includes("R") || status.includes("C")) index += 1;
    }

    return entries;
  }

  return output
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0)
    .map((line) => {
      const value = line.slice(3);
      return { path: value.includes(" -> ") ? value.split(" -> ").pop()! : value, status: line.slice(0, 2) };
    });
}

async function filesystemMutationFingerprint(context: ProjectContext, ignoredPaths: Set<string>): Promise<string> {
  const entries: Array<{ content?: string; path: string; target?: string; type: string }> = [];
  await collectFilesystemFingerprintEntries(context, context.root, ignoredPaths, entries);
  entries.sort((left, right) => left.path.localeCompare(right.path));
  return JSON.stringify({ entries, mode: "filesystem" });
}

async function collectFilesystemFingerprintEntries(
  context: ProjectContext,
  absolutePath: string,
  ignoredPaths: Set<string>,
  entries: Array<{ content?: string; path: string; target?: string; type: string }>,
): Promise<void> {
  const relativePath = path.relative(context.root, absolutePath).split(path.sep).join(path.posix.sep);
  if (relativePath.length > 0 && isIgnoredRelativePath(relativePath, ignoredPaths)) return;
  if (relativePath.length > 0 && isIgnoredFilesystemFingerprintPath(context, relativePath, absolutePath)) return;

  let stat: Stats;
  try {
    stat = await lstat(absolutePath);
  } catch (error) {
    /* v8 ignore start -- lstat failures during traversal are filesystem races. */
    entries.push({ path: relativePath, type: `unreadable:${(error as NodeJS.ErrnoException).code ?? "unknown"}` });
    return;
    /* v8 ignore stop */
  }

  if (stat.isDirectory()) {
    let names: string[];
    try {
      names = await readdir(absolutePath);
    } catch (error) {
      /* v8 ignore start -- directory read failures during traversal are filesystem races. */
      entries.push({ path: relativePath, type: `unreadable-directory:${(error as NodeJS.ErrnoException).code ?? "unknown"}` });
      return;
      /* v8 ignore stop */
    }

    await Promise.all(names.sort().map((name) => collectFilesystemFingerprintEntries(context, path.join(absolutePath, name), ignoredPaths, entries)));
    return;
  }

  if (stat.isSymbolicLink()) {
    try {
      entries.push({ path: relativePath, target: await readlink(absolutePath), type: "symlink" });
    } catch (error) {
      /* v8 ignore next -- symlink read failures during traversal are filesystem races. */
      entries.push({ path: relativePath, type: `unreadable-symlink:${(error as NodeJS.ErrnoException).code ?? "unknown"}` });
    }
    return;
  }

  if (stat.isFile()) {
    entries.push({ content: await fileFingerprint(absolutePath), path: relativePath, type: "file" });
    return;
  }

  /* v8 ignore next -- special filesystem nodes are platform-specific and defensive. */
  entries.push({ path: relativePath, type: "other" });
}

async function gitStatusOutput(context: ProjectContext, includeIgnoredFiles: boolean): Promise<string | null> {
  try {
    const args = ["status", "--porcelain=v1", "-z", "--untracked-files=all"];
    if (includeIgnoredFiles) args.push("--ignored=matching");
    const result = await execFileAsync("git", args, { cwd: context.root, env: process.env, maxBuffer: 20 * 1024 * 1024 });
    return result.stdout;
  } catch {
    return null;
  }
}

async function gitHead(context: ProjectContext): Promise<string | null> {
  try {
    const result = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: context.root, env: process.env });
    return result.stdout.trim();
  } catch {
    return null;
  }
}

async function fileFingerprint(filePath: string): Promise<string> {
  try {
    return createHash("sha256")
      .update(await readFile(filePath))
      .digest("hex");
  } catch (error) {
    return `unreadable:${(error as NodeJS.ErrnoException).code ?? "unknown"}`;
  }
}

function isRoadrunnerRuntimePath(context: ProjectContext, relativePath: string): boolean {
  const absolutePath = path.resolve(context.root, relativePath);
  return isSameOrInside(context.paths.logs, absolutePath) || absolutePath === context.paths.processRegistry || absolutePath === context.paths.lock;
}

function normalizedIgnoredPaths(context: ProjectContext, ignoredPaths: string[]): Set<string> {
  const normalized = new Set<string>();
  for (const ignoredPath of ignoredPaths) {
    const absolutePath = path.isAbsolute(ignoredPath) ? ignoredPath : path.resolve(context.root, ignoredPath);
    const relativePath = path.relative(context.root, absolutePath).split(path.sep).join(path.posix.sep);
    if (relativePath.length > 0 && !relativePath.startsWith("../") && !path.isAbsolute(relativePath)) normalized.add(relativePath);
  }
  return normalized;
}

function isIgnoredRelativePath(relativePath: string, ignoredPaths: Set<string>): boolean {
  for (const ignoredPath of ignoredPaths) {
    if (relativePath === ignoredPath || relativePath.startsWith(`${ignoredPath}/`)) return true;
  }
  return false;
}

function isIgnoredFilesystemFingerprintPath(context: ProjectContext, relativePath: string, absolutePath: string): boolean {
  if (isRoadrunnerRuntimePath(context, relativePath)) return true;
  return (
    relativePath.split(path.posix.sep).some((segment) => fallbackFingerprintIgnoredDirectories.has(segment)) ||
    isSameOrInside(path.join(context.root, ".roadrunner", "logs"), absolutePath)
  );
}

function isExcludedIgnoredStatusPath(context: ProjectContext, entry: StatusEntry): boolean {
  if (entry.status !== "!!") return false;
  return isIgnoredFilesystemFingerprintPath(context, entry.path, path.resolve(context.root, entry.path));
}

function isSameOrInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative.length === 0 || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
