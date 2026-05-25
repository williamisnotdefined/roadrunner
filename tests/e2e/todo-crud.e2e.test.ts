import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import { main } from "../../src/cli.js";
import { readJson, writeJson } from "../../src/config.js";
import type { QueueFile } from "../../src/queue.js";
import { commitAll, createFakeOpenCodeBin, initGit, run, withPath } from "../helpers.js";

const outputRoot = path.resolve("test-output/e2e/todo-crud");
const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
});

describe("todo CRUD e2e", () => {
  test("runs Roadrunner from goals and roadmap to satisfied project state", async () => {
    await rm(outputRoot, { force: true, recursive: true });
    await mkdir(outputRoot, { recursive: true });
    const binDir = await createFakeOpenCodeBin(outputRoot);
    process.env.PATH = withPath(binDir);
    process.env.ROADRUNNER_FAKE_OPENCODE_MODE = "todo-e2e";
    delete process.env.OPENCODE_SESSION;
    delete process.env.OPENCODE_SESSION_ID;
    delete process.env.OPENCODE_SERVER;
    delete process.env.OPENCODE_WORKSPACE;
    delete process.env.OPENCODE_APP_INFO;

    await writeFile(
      path.join(outputRoot, "GOALS.md"),
      `# Todo CRUD Goals

Build a minimal Todo CRUD library with tests. Generated application code must stay in this target project.
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
Prompt: Implement a minimal Todo CRUD store and tests.
Acceptance:
- todos can be created, listed, updated, and deleted
- project tests pass
Verification:
- npm test
Commit: Implement Todo CRUD
`,
    );

    expect(await main(["init", "--goals", "GOALS.md", "--roadmap", "ROADMAP.md"], { cwd: outputRoot })).toBe(0);
    const config = await readJson<Record<string, unknown>>(path.join(outputRoot, ".roadrunner/config.json"));
    await writeJson(path.join(outputRoot, ".roadrunner/config.json"), { ...config, allowNestedOpenCode: true });
    await initGit(outputRoot);
    await commitAll(outputRoot, "Initial Todo CRUD target");

    expect(await main(["run", "--max-steps", "1"], { cwd: outputRoot })).toBe(0);

    const queue = await readJson<QueueFile>(path.join(outputRoot, ".roadrunner/queue.json"));
    const testResult = await run("npm", ["test"], outputRoot);
    const gitStatus = await run("git", ["status", "--short"], outputRoot);

    expect(queue.queue).toEqual([]);
    expect(queue.history.map((step) => step.id)).toEqual(["todo-crud"]);
    expect(queue.blocked).toEqual([]);
    expect(testResult.stdout).toMatch(/supports todo CRUD/);
    expect(gitStatus.stdout).toMatch(/src\//);
    expect(await readFile(path.join(outputRoot, "src/todos.js"), "utf8")).toMatch(/createTodoStore/);
    expect(path.relative(path.resolve("test-output/e2e"), outputRoot)).toBe("todo-crud");
  }, 30_000);
});
