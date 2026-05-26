import { execFile } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { loadContext, writeJson, type ProjectContext } from "../src/infrastructure/config.js";
import { initProject } from "../src/application/init.js";

const execFileAsync = promisify(execFile);

export async function tempDir(prefix: string): Promise<string> {
  const directory = await import("node:fs/promises").then((fs) => fs.mkdtemp(path.join(os.tmpdir(), prefix)));
  return directory;
}

export async function removeDir(directory: string): Promise<void> {
  await rm(directory, { force: true, recursive: true });
}

export async function run(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv = process.env): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync(command, args, { cwd, env }) as Promise<{ stdout: string; stderr: string }>;
}

export async function initGit(directory: string): Promise<void> {
  await run("git", ["init"], directory);
  await run("git", ["config", "user.email", "roadrunner-test@example.com"], directory);
  await run("git", ["config", "user.name", "Roadrunner Test"], directory);
}

export async function commitAll(directory: string, message: string): Promise<void> {
  await run("git", ["add", "-A"], directory);
  await run("git", ["commit", "-m", message], directory);
}

export async function createInitializedProject(directory: string, roadmap = sampleRoadmap()): Promise<ProjectContext> {
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "GOALS.md"), "# Goals\n\nBuild the requested project.\n");
  await writeFile(path.join(directory, "ROADMAP.md"), roadmap);
  const context = await loadContext(directory, { _: [] });
  await initProject(context);
  await writeJson(context.paths.config, { ...context.config, allowNestedOpenCode: true, paths: context.config.paths });
  return { ...(await loadContext(directory, { _: [] })), config: { ...(await loadContext(directory, { _: [] })).config, allowNestedOpenCode: true } };
}

export async function createFakeOpenCodeBin(directory: string): Promise<string> {
  const binDir = path.join(directory, "bin");
  await mkdir(binDir, { recursive: true });
  const scriptPath = path.join(binDir, "opencode");
  await writeFile(scriptPath, fakeOpenCodeScript(), { mode: 0o755 });
  return binDir;
}

export function withPath(binDir: string): string {
  return `${binDir}${path.delimiter}${process.env.PATH ?? ""}`;
}

export function sampleRoadmap({ verification = "node -e \"require('node:fs').readFileSync('marker.txt', 'utf8').includes('ok') || process.exit(1)\"" } = {}): string {
  return `# Roadmap

## first-step: Build first step

Phase: Bootstrap
Scope: marker.txt
Prompt: Create marker.txt with ok content.
Acceptance:
- marker exists
Verification:
- ${verification}
`;
}

function fakeOpenCodeScript(): string {
  return (
    `#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";

const fileIndex = process.argv.indexOf("--file");
const promptFile = fileIndex >= 0 ? process.argv[fileIndex + 1] : "";
const prompt = promptFile ? fs.readFileSync(promptFile, "utf8") : process.argv[process.argv.length - 1] || "";
const mode = process.env.ROADRUNNER_FAKE_OPENCODE_MODE || "success";
const realGit = process.env.ROADRUNNER_TEST_REAL_GIT || "/usr/bin/git";
if (process.env.ROADRUNNER_FAKE_OPENCODE_ARGS_FILE) {
  fs.writeFileSync(process.env.ROADRUNNER_FAKE_OPENCODE_ARGS_FILE, JSON.stringify(process.argv.slice(2)) + "\\n");
}
if (process.env.ROADRUNNER_FAKE_OPENCODE_ENV_FILE) {
  fs.writeFileSync(process.env.ROADRUNNER_FAKE_OPENCODE_ENV_FILE, JSON.stringify({ ROADRUNNER_PROVIDER_TIMEOUT_MS: process.env.ROADRUNNER_PROVIDER_TIMEOUT_MS ?? null }) + "\\n");
}
if (process.env.ROADRUNNER_FAKE_OPENCODE_NESTED_ENV_FILE) {
  fs.writeFileSync(process.env.ROADRUNNER_FAKE_OPENCODE_NESTED_ENV_FILE, JSON.stringify({ OPENCODE_SESSION: process.env.OPENCODE_SESSION ?? null, OPENCODE_SERVER: process.env.OPENCODE_SERVER ?? null }) + "\\n");
}

if (process.argv.includes("--help")) {
  console.log("--model --variant --agent --file --dangerously-skip-permissions");
  process.exit(0);
}

function runChecked(command, args) {
  try {
    execFileSync(command, args, { stdio: "inherit" });
  } catch (error) {
    process.exit(typeof error.status === "number" ? error.status : 1);
  }
}

if (prompt.includes("Roadrunner Startup Queue Refresh")) {
  const queuePath = path.join(".roadrunner", "state", "queue.json");
  if (mode === "startup-refresh-extra") fs.writeFileSync("unexpected-startup.txt", "nope\\n");
  if (mode === "startup-refresh-invalid") {
    const queue = JSON.parse(fs.readFileSync(queuePath, "utf8"));
    queue.version = 99;
    fs.writeFileSync(queuePath, JSON.stringify(queue, null, 2) + "\\n");
  }
  if (mode === "startup-refresh-fail") {
    console.error("startup refresh failed");
    process.exit(9);
  }
  if (mode === "startup-refresh-inferred-done") {
    const queue = JSON.parse(fs.readFileSync(queuePath, "utf8"));
    const completed = queue.queue.shift();
    if (completed) queue.history.push({ ...completed, completedAt: "2026-01-01T00:00:00.000Z" });
    fs.writeFileSync(queuePath, JSON.stringify(queue, null, 2) + "\\n");
  }
  if (mode === "startup-refresh-from-strategic") {
    const queue = JSON.parse(fs.readFileSync(queuePath, "utf8"));
    queue.queue = [{ id: "strategic-step", phase: "Strategy", title: "Build strategic step", scope: ["marker.txt"], prompt: "Create marker.txt with ok content.", acceptance: ["marker exists"], verification: ["node -e \\"require('node:fs').readFileSync('marker.txt', 'utf8').includes('ok') || process.exit(1)\\""] }];
    fs.writeFileSync(queuePath, JSON.stringify(queue, null, 2) + "\\n");
  }
  console.log("startup refreshed");
  process.exit(0);
}

if (mode === "provider-fail-queue-dirty" && prompt.includes("Roadrunner Implement Step")) {
  const queuePath = path.join(".roadrunner", "state", "queue.json");
  const queue = JSON.parse(fs.readFileSync(queuePath, "utf8"));
  queue.queue[0].title = "Provider changed title before failing";
  fs.writeFileSync(queuePath, JSON.stringify(queue, null, 2) + "\\n");
  console.error("implementation failed");
  process.exit(7);
}

if (mode === "provider-fail-invalid-queue" && prompt.includes("Roadrunner Implement Step")) {
  const queuePath = path.join(".roadrunner", "state", "queue.json");
  const queue = JSON.parse(fs.readFileSync(queuePath, "utf8"));
  queue.version = 99;
  fs.writeFileSync(queuePath, JSON.stringify(queue, null, 2) + "\\n");
  console.error("implementation failed");
  process.exit(7);
}

if (mode === "provider-fail-other-current" && prompt.includes("Roadrunner Implement Step")) {
  const queuePath = path.join(".roadrunner", "state", "queue.json");
  const queue = JSON.parse(fs.readFileSync(queuePath, "utf8"));
  queue.queue.unshift({ ...queue.queue[0], id: "other-step", title: "Other current step" });
  fs.writeFileSync(queuePath, JSON.stringify(queue, null, 2) + "\\n");
  console.error("implementation failed");
  process.exit(7);
}

if (mode === "provider-fail" && prompt.includes("Roadrunner Implement Step")) {
  console.error("implementation failed");
  process.exit(7);
}

if (mode === "plan-fail" && prompt.includes("Roadrunner Plan Step")) {
  console.error("planning failed");
  process.exit(6);
}

if (mode === "fix-fail" && prompt.includes("Roadrunner Fix Failure")) {
  console.error("fix failed");
  process.exit(8);
}

if (mode === "hang") {
  console.log("hanging");
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
}

if (mode === "hang-once-plan" && prompt.includes("Roadrunner Plan Step")) {
  const marker = ".fake-hang-once-plan";
  if (!fs.existsSync(marker)) {
    fs.writeFileSync(marker, "hung\\n");
    console.log("hanging once");
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
  }
}

if (mode === "slow-plan-success" && prompt.includes("Roadrunner Plan Step")) {
  let ticks = 0;
  const interval = setInterval(() => {
    ticks += 1;
    console.log("tick " + ticks);
    if (ticks === 4) {
      clearInterval(interval);
      console.log("Plan: slow success.");
      process.exit(0);
    }
  }, 20);
  await new Promise(() => {});
}

if (mode === "spawn-child-on-term") {
  const childPidFile = process.env.ROADRUNNER_FAKE_OPENCODE_CHILD_PID_FILE || "";
  const child = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); if (process.argv[1]) require('node:fs').writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 1000);", childPidFile], { stdio: "ignore" });
  process.on("SIGTERM", () => process.exit(0));
  console.log("spawned child");
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
}

if (prompt.includes("Roadrunner Plan Step")) {
  if (mode === "plan-dirty") fs.writeFileSync("plan-dirty.txt", "nope\\n");
  if (mode === "plan-ignored-dirty") fs.writeFileSync(".env", "SECRET=changed\\n");
  if (mode === "plan-delete") fs.rmSync("delete-me.txt", { force: true });
  console.log("Plan: implement the requested step.");
  process.exit(0);
}

if (prompt.includes("Roadrunner Implement Step")) {
  if (mode === "goals-dirty") {
    fs.writeFileSync("GOALS.md", "changed\\n");
    fs.writeFileSync("marker.txt", "ok\\n");
  } else if (mode === "goals-snapshot") {
    fs.writeFileSync("GOALS.md", "# Goals\\n\\nChanged during run.\\n");
    fs.writeFileSync("marker.txt", "ok\\n");
    fs.writeFileSync("goal-snapshot.txt", prompt.includes("Build the requested project.") ? "original\\n" : "changed\\n");
  } else if (mode === "todo-e2e") {
    fs.mkdirSync("src", { recursive: true });
    fs.mkdirSync("test", { recursive: true });
    fs.writeFileSync("package.json", JSON.stringify({ type: "module", scripts: { test: "node --test" } }, null, 2) + "\\n");
    fs.writeFileSync("src/todos.js", ` +
    JSON.stringify(`export function createTodoStore() {
  const todos = new Map();
  let nextId = 1;
  return {
    create(title) {
      const todo = { id: nextId++, title, completed: false };
      todos.set(todo.id, todo);
      return { ...todo };
    },
    list() {
      return [...todos.values()].map((todo) => ({ ...todo }));
    },
    update(id, patch) {
      const current = todos.get(id);
      if (!current) return null;
      const updated = { ...current, ...patch, id };
      todos.set(id, updated);
      return { ...updated };
    },
    remove(id) {
      return todos.delete(id);
    },
  };
}
`) +
    `);
    fs.writeFileSync("test/todos.test.js", ` +
    JSON.stringify(`import test from "node:test";
import assert from "node:assert/strict";
import { createTodoStore } from "../src/todos.js";

test("supports todo CRUD", () => {
  const store = createTodoStore();
  const todo = store.create("Ship Roadrunner");
  assert.deepEqual(store.list(), [todo]);
  assert.equal(store.update(todo.id, { completed: true })?.completed, true);
  assert.equal(store.remove(todo.id), true);
  assert.deepEqual(store.list(), []);
});
`) +
    `);
  } else if (mode === "noop") {
    // no changes
  } else if (mode === "queue-dirty") {
    fs.writeFileSync("marker.txt", "ok\\n");
    const queuePath = path.join(".roadrunner", "state", "queue.json");
    const queue = JSON.parse(fs.readFileSync(queuePath, "utf8"));
    queue.queue[0].title = "Implementation touched queue";
    fs.writeFileSync(queuePath, JSON.stringify(queue, null, 2) + "\\n");
  } else if (mode === "queue-dirty-hang") {
    fs.writeFileSync("marker.txt", "ok\\n");
    const queuePath = path.join(".roadrunner", "state", "queue.json");
    const queue = JSON.parse(fs.readFileSync(queuePath, "utf8"));
    queue.queue[0].title = "Implementation touched queue before restart";
    fs.writeFileSync(queuePath, JSON.stringify(queue, null, 2) + "\\n");
    console.log("queue dirty before hang");
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
  } else if (mode === "git-commit") {
    fs.writeFileSync("marker.txt", "ok\\n");
    runChecked("git", ["add", "marker.txt"]);
    runChecked("git", ["commit", "-m", "Agent commit"]);
  } else if (mode === "git-push") {
    runChecked("git", ["push"]);
  } else if (mode === "goals-commit-bypass") {
    fs.writeFileSync("GOALS.md", "changed\\n");
    fs.writeFileSync("marker.txt", "ok\\n");
    runChecked(realGit, ["add", "GOALS.md", "marker.txt"]);
    runChecked(realGit, ["commit", "-m", "Agent changed goals"]);
  } else if (mode === "implementation-commit-bypass") {
    fs.writeFileSync("marker.txt", "ok\\n");
    runChecked(realGit, ["add", "marker.txt"]);
    runChecked(realGit, ["commit", "-m", "Agent implementation commit"]);
    runChecked(realGit, ["tag", "-f", "baseline-tag"]);
  } else if (mode === "verify-fail" || mode === "fix-success" || mode === "fix-fail" || mode === "fix-commit-bypass" || mode === "fix-queue-dirty") {
    fs.writeFileSync("marker.txt", "bad\\n");
  } else {
    fs.writeFileSync("marker.txt", "ok\\n");
  }
  console.log("implemented");
  process.exit(0);
}

if (prompt.includes("Roadrunner Fix Failure")) {
  fs.writeFileSync("marker.txt", "ok\\n");
  if (mode === "fix-queue-dirty") {
    const queuePath = path.join(".roadrunner", "state", "queue.json");
    const queue = JSON.parse(fs.readFileSync(queuePath, "utf8"));
    queue.queue[0].title = "Fix touched queue";
    fs.writeFileSync(queuePath, JSON.stringify(queue, null, 2) + "\\n");
  }
  if (mode === "fix-commit-bypass") {
    runChecked(realGit, ["add", "marker.txt"]);
    runChecked(realGit, ["commit", "-m", "Agent fix commit"]);
  }
  console.log("fixed");
  process.exit(0);
}

if (prompt.includes("Roadrunner Reconcile Queue") || prompt.includes("Roadrunner Reconcile And Optimize Queue")) {
  if (mode === "reconcile-fail-dirty") {
    fs.writeFileSync("unexpected.txt", "nope\\n");
    console.error("reconcile failed");
    process.exit(9);
  }
  if (mode === "reconcile-fail") {
    console.error("reconcile failed");
    process.exit(9);
  }
  if (mode === "reconcile-extra") fs.writeFileSync("unexpected.txt", "nope\\n");
  if (mode === "reconcile-ignored-dirty") fs.writeFileSync(".env", "SECRET=changed\\n");
  if (mode === "reconcile-commit-bypass") {
    fs.writeFileSync("unexpected.txt", "nope\\n");
    runChecked(realGit, ["add", "unexpected.txt"]);
    runChecked(realGit, ["commit", "-m", "Agent reconcile commit"]);
  }
  if (mode === "reconcile-invalid") {
    const queuePath = path.join(".roadrunner", "state", "queue.json");
    const queue = JSON.parse(fs.readFileSync(queuePath, "utf8"));
    queue.version = 99;
    fs.writeFileSync(queuePath, JSON.stringify(queue, null, 2) + "\\n");
  }
  if (mode === "reconcile-closed") {
    const queuePath = path.join(".roadrunner", "state", "queue.json");
    const queue = JSON.parse(fs.readFileSync(queuePath, "utf8"));
    queue.history = [];
    queue.blocked = [];
    fs.writeFileSync(queuePath, JSON.stringify(queue, null, 2) + "\\n");
  }
  if (mode === "reconcile-queue") {
    const queuePath = path.join(".roadrunner", "state", "queue.json");
    const queue = JSON.parse(fs.readFileSync(queuePath, "utf8"));
    queue.queue[0].title = "Reconciled first step";
    fs.writeFileSync(queuePath, JSON.stringify(queue, null, 2) + "\\n");
  }
  if (mode === "reconcile-removes-current") {
    const queuePath = path.join(".roadrunner", "state", "queue.json");
    const queue = JSON.parse(fs.readFileSync(queuePath, "utf8"));
    queue.queue.shift();
    fs.writeFileSync(queuePath, JSON.stringify(queue, null, 2) + "\\n");
  }
  if (mode === "reconcile-future-queue") {
    const queuePath = path.join(".roadrunner", "state", "queue.json");
    const queue = JSON.parse(fs.readFileSync(queuePath, "utf8"));
    if (queue.queue[0]) queue.queue[0].title = "Reconciled future step";
    fs.writeFileSync(queuePath, JSON.stringify(queue, null, 2) + "\\n");
  }
  console.log("reconciled");
  process.exit(0);
}

console.log("ok");
`
  );
}
