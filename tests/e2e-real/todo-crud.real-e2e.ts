#!/usr/bin/env tsx

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { main } from "../../src/cli/index.js";
import { readJson, writeJson } from "../../src/infrastructure/config.js";
import type { QueueFile } from "../../src/domain/queue.js";
import { run as runRoadrunner } from "../../src/application/runner.js";
import { run } from "../helpers.js";

const execFileAsync = promisify(execFile);

if (process.env.ROADRUNNER_E2E_REAL_OPENCODE !== "1") {
  throw new Error("Refusing to run real OpenCode e2e without ROADRUNNER_E2E_REAL_OPENCODE=1.");
}

await ensureOpenCode();
const outputRoot = await createOutputRoot();

await writeFile(
  path.join(outputRoot, "GOALS.md"),
  `# Todo CRUD Goals

Build a minimal JavaScript Todo CRUD library with deterministic tests.

Requirements:

- Keep generated application code inside this target project.
- Use Node's built-in test runner.
- Export createTodoStore from src/todos.js with create, list, update, and remove methods.
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
Prompt: Implement a minimal dependency-free ESM Todo CRUD store. Export createTodoStore from src/todos.js with create(title), list(), update(id, patch), and remove(id). Add a Node test suite that exercises that API.
Acceptance:
- createTodoStore is exported from src/todos.js
- todos can be created, listed, updated, and deleted
- tests exercise the full CRUD behavior
- npm test passes
Verification:
- npm test
`,
);

await requireOk(main(["init", "--goals", "GOALS.md", "--roadmap", "ROADMAP.md"], { cwd: outputRoot }), "roadrunner init failed");
const configPath = path.join(outputRoot, ".roadrunner/config.json");
const config = await readJson<Record<string, unknown>>(configPath);
await writeJson(configPath, { ...config, allowNestedOpenCode: true, dangerouslySkipPermissions: true });

await requireOk(
  main(["run", "--max-steps", "1"], {
    cwd: outputRoot,
    runTui: (context, options) => runRoadrunner(context, { maxHours: options.maxHours, maxSteps: options.maxSteps }),
    terminal: { isInteractive: true },
  }),
  "roadrunner run failed",
);

const queue = await readJson<QueueFile>(path.join(outputRoot, ".roadrunner/queue.json"));
assert(queue.queue.length === 0, "Expected queue to be empty.");
assert(queue.history.map((step) => step.id).includes("todo-crud"), "Expected todo-crud in history.");
assert(queue.blocked.length === 0, "Expected blocked queue to be empty.");

const testResult = await run("npm", ["test"], outputRoot);
assert(testResult.stdout.includes("todo") || testResult.stdout.includes("CRUD"), "Expected generated Todo tests to run.");

await assertTodoApi(outputRoot);
assert((await readFile(path.join(outputRoot, "src/todos.js"), "utf8")).includes("createTodoStore"), "Expected generated Todo source file to export createTodoStore.");

console.log(`Real OpenCode e2e completed in ${outputRoot}`);

async function createOutputRoot(): Promise<string> {
  const parent = path.resolve("test-output/e2e-real");
  await mkdir(parent, { recursive: true });
  return mkdtemp(path.join(parent, "todo-crud-"));
}

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

async function assertTodoApi(cwd: string): Promise<void> {
  await run(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import { createTodoStore } from "./src/todos.js";
const store = createTodoStore();
const todo = store.create("Ship Roadrunner");
if (!todo || todo.title !== "Ship Roadrunner") throw new Error("create failed");
if (store.list().length !== 1) throw new Error("list failed");
const updated = store.update(todo.id, { completed: true });
if (!updated?.completed) throw new Error("update failed");
if (!store.remove(todo.id)) throw new Error("remove failed");
if (store.list().length !== 0) throw new Error("final list failed");`,
    ],
    cwd,
  );
}

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
