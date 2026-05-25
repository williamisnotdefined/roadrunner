#!/usr/bin/env node

import type { Dirent } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

interface SizeRule {
  directory: string;
  limit: number;
}

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.basename(path.resolve(scriptDir, "..")) === "dist" ? path.resolve(scriptDir, "../..") : path.resolve(scriptDir, "..");
const rules: SizeRule[] = [
  { directory: "src", limit: 300 },
  { directory: "tests", limit: 400 },
];

const violations: string[] = [];

for (const rule of rules) {
  for (const filePath of await listTypeScriptFiles(path.join(rootDir, rule.directory))) {
    const lines = lineCount(await readFile(filePath, "utf8"));
    if (lines > rule.limit) violations.push(`${path.relative(rootDir, filePath)} has ${lines} lines; limit is ${rule.limit}.`);
  }
}

if (violations.length > 0) {
  console.error(`File size guardrail failed:\n${violations.map((violation) => `- ${violation}`).join("\n")}`);
  process.exit(1);
}

console.log("File size guardrail passed.");

async function listTypeScriptFiles(directory: string): Promise<string[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return [];
  }

  const files: string[] = [];
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await listTypeScriptFiles(entryPath)));
    if (entry.isFile() && entry.name.endsWith(".ts")) files.push(entryPath);
  }

  return files;
}

function lineCount(content: string): number {
  if (content.length === 0) return 0;
  return content.endsWith("\n") ? content.split("\n").length - 1 : content.split("\n").length;
}
