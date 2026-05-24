#!/usr/bin/env tsx

import { execFile } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { main } from "../../src/cli.js";
import { readJson, writeJson } from "../../src/config.js";
import type { QueueFile } from "../../src/queue.js";
import { commitAll, initGit, run } from "../helpers.js";

const execFileAsync = promisify(execFile);
const outputRoot = path.resolve("test-output/e2e-real/todo-crud");

if (process.env.ROADRUNNER_E2E_REAL_OPENCODE !== "1") {
  throw new Error("Refusing to run real OpenCode e2e without ROADRUNNER_E2E_REAL_OPENCODE=1.");
}

await ensureOpenCode();
await rm(outputRoot, { force: true, recursive: true });
await mkdir(outputRoot, { recursive: true });

await writeFile(
  path.join(outputRoot, "GOALS.md"),
  `# Todo CRUD Goals

Build a minimal JavaScript Todo CRUD library with deterministic tests.

Requirements:

- Keep generated application code inside this target project.
- Use Node's built-in test runner.
- Provide create, list, update, and delete behavior.
`,
);

await writeFile(
  path.join(outputRoot, "ROADMAP.md"),
  `# Todo CRUD Roadmap

## todo-crud: Implement Todo CRUD

Phase: App
Scope:
- package.json
- src/todos.js
- test/todos.test.js
Prompt: Implement a minimal ESM Todo CRUD store and a Node test suite. Keep the implementation dependency-free.
Acceptance:
- todos can be created, listed, updated, and deleted
- tests exercise the full CRUD behavior
- npm test passes
Verification:
- npm test
Commit: Implement Todo CRUD
`,
);

await requireOk(main(["init", "--goals", "GOALS.md", "--roadmap", "ROADMAP.md"], { cwd: outputRoot }), "roadrunner init failed");
const configPath = path.join(outputRoot, ".roadrunner/config.json");
const config = await readJson<Record<string, unknown>>(configPath);
await writeJson(configPath, { ...config, allowNestedOpenCode: true });
await initGit(outputRoot);
await commitAll(outputRoot, "Initial Todo CRUD target");

await requireOk(main(["run", "--max-steps", "1"], { cwd: outputRoot }), "roadrunner run failed");

const queue = await readJson<QueueFile>(path.join(outputRoot, ".roadrunner/queue.json"));
assert(queue.queue.length === 0, "Expected queue to be empty.");
assert(queue.history.map((step) => step.id).includes("todo-crud"), "Expected todo-crud in history.");
assert(queue.blocked.length === 0, "Expected blocked queue to be empty.");

const testResult = await run("npm", ["test"], outputRoot);
assert(testResult.stdout.includes("todo") || testResult.stdout.includes("CRUD"), "Expected generated Todo tests to run.");

const gitLog = await run("git", ["log", "--oneline"], outputRoot);
assert(gitLog.stdout.split("\n").filter(Boolean).length >= 2, "Expected Roadrunner to create at least one commit.");
assert((await readFile(path.join(outputRoot, "src/todos.js"), "utf8")).length > 0, "Expected generated Todo source file.");

console.log(`Real OpenCode e2e completed in ${outputRoot}`);

async function ensureOpenCode(): Promise<void> {
  try {
    await execFileAsync("opencode", ["--version"]);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") throw new Error("opencode was not found in PATH.");
  }
}

async function requireOk(result: Promise<number>, message: string): Promise<void> {
  const code = await result;
  if (code !== 0) throw new Error(`${message} Exit code: ${code}.`);
}

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
