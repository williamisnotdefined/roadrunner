#!/usr/bin/env tsx

import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const binPath = "dist/src/cli/index.js";
const requiredFiles = ["README.md", binPath, "package.json", "templates/GOALS.md", "templates/prompts/plan-step.md", "templates/prompts/startup-refresh.md", "templates/queue.json"];

try {
  const packageJson = JSON.parse(await readFile("package.json", "utf8")) as { bin?: Record<string, string> };
  if (packageJson.bin?.roadrunner !== binPath) throw new Error(`package.json bin.roadrunner must point to ${binPath}.`);

  const binMode = (await stat(binPath)).mode;
  if ((binMode & 0o111) === 0) throw new Error(`${binPath} must be executable for npm link and package bin shims.`);

  const result = await execFileAsync("npm", ["pack", "--dry-run", "--json"], { maxBuffer: 10 * 1024 * 1024 });
  const packs = JSON.parse(result.stdout) as Array<{ files?: Array<{ path: string }> }>;
  const files = new Set(packs[0]?.files?.map((file) => file.path) ?? []);
  const missing = requiredFiles.filter((file) => !files.has(file));
  if (missing.length > 0) throw new Error(`Package dry-run is missing: ${missing.join(", ")}.`);

  console.log(`Package dry-run includes ${files.size} files and roadrunner bin.`);
} catch (error) {
  console.error((error as Error).message);
  process.exitCode = 1;
}
