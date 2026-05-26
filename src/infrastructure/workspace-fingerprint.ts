import { createHash } from "node:crypto";
import type { Dirent } from "node:fs";
import { lstat, readdir, readFile, readlink } from "node:fs/promises";
import path from "node:path";

import type { ProjectContext } from "./config.js";

export interface WorkspaceFingerprint {
  entries: Map<string, string>;
}

export async function workspaceFingerprint(context: ProjectContext): Promise<WorkspaceFingerprint> {
  const ignored = ignoredPaths(context);
  return { entries: await fingerprintDirectory(context.root, context.root, ignored) };
}

export function workspaceFingerprintChanges(before: WorkspaceFingerprint, after: WorkspaceFingerprint): string[] {
  const changes: string[] = [];
  const paths = new Set([...before.entries.keys(), ...after.entries.keys()]);
  for (const filePath of [...paths].sort()) {
    if (before.entries.get(filePath) !== after.entries.get(filePath)) changes.push(filePath);
  }
  return changes;
}

async function fingerprintDirectory(root: string, directory: string, ignored: string[]): Promise<Map<string, string>> {
  const entries = new Map<string, string>();
  let dirents: Dirent[];
  try {
    dirents = await readdir(directory, { withFileTypes: true });
  } catch {
    return entries;
  }

  for (const dirent of dirents.sort((left, right) => left.name.localeCompare(right.name))) {
    const entryPath = path.join(directory, dirent.name);
    if (isIgnored(entryPath, ignored)) continue;
    const relative = path.relative(root, entryPath).split(path.sep).join(path.posix.sep);
    const stat = await lstat(entryPath);
    if (stat.isDirectory()) {
      mergeEntries(entries, await fingerprintDirectory(root, entryPath, ignored));
      continue;
    }
    if (stat.isSymbolicLink()) {
      entries.set(relative, `symlink:${await readlink(entryPath)}`);
      continue;
    }
    if (!stat.isFile()) {
      entries.set(relative, `${stat.mode}:${stat.size}:${stat.mtimeMs}`);
      continue;
    }
    entries.set(relative, `${stat.mode}:${hash(await readFile(entryPath))}`);
  }

  return entries;
}

function ignoredPaths(context: ProjectContext): string[] {
  return [
    path.join(context.root, ".git"),
    context.paths.logs,
    context.paths.lock,
    context.paths.processRegistry,
    `${context.paths.processRegistry}.lock`,
  ].map((filePath) => path.resolve(filePath));
}

function isIgnored(filePath: string, ignored: string[]): boolean {
  const resolved = path.resolve(filePath);
  return ignored.some((ignoredPath) => resolved === ignoredPath || resolved.startsWith(`${ignoredPath}${path.sep}`));
}

function mergeEntries(target: Map<string, string>, source: Map<string, string>): void {
  for (const [key, value] of source) target.set(key, value);
}

function hash(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}
