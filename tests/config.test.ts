import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";

import { defaultModel, defaultVariant, loadContext, packageRootFromSourceRoot, pathExists, pathOverridesFromArgs, projectPaths, readJson, writeJson } from "../src/config.js";

describe("config", () => {
  test("builds default and absolute project paths", () => {
    const root = path.join(os.tmpdir(), "roadrunner-root");
    const paths = projectPaths(root, { goals: "/tmp/goals.md", roadmap: "docs/ROADMAP.md" });

    expect(paths.goals).toBe("/tmp/goals.md");
    expect(paths.roadmap).toBe(path.join(root, "docs/ROADMAP.md"));
    expect(paths.config).toBe(path.join(root, ".roadrunner/config.json"));
    expect(packageRootFromSourceRoot(path.join(root, "dist"))).toBe(root);
    expect(packageRootFromSourceRoot(path.join(root, "src"))).toBe(path.join(root, "src"));
  });

  test("extracts path overrides from args", () => {
    expect(
      pathOverridesFromArgs({
        _: [],
        config: "config.json",
        goal: "GOAL.md",
        goals: "GOALS.md",
        lock: "lock",
        logs: "logs",
        processes: "processes.json",
        prompts: "prompts",
        queue: "queue.json",
        roadmap: "ROADMAP.md",
      }),
    ).toEqual({
      config: "config.json",
      goal: "GOAL.md",
      goals: "GOALS.md",
      lock: "lock",
      logs: "logs",
      processes: "processes.json",
      prompts: "prompts",
      queue: "queue.json",
      roadmap: "ROADMAP.md",
    });
  });

  test("loadContext uses defaults and nested config", async () => {
    const tempDir = await import("node:fs/promises").then((fs) => fs.mkdtemp(path.join(os.tmpdir(), "roadrunner-config-default-")));
    try {
      await mkdir(path.join(tempDir, ".roadrunner"), { recursive: true });
      await writeFile(
        path.join(tempDir, ".roadrunner/config.json"),
        `${JSON.stringify({ allowNestedOpenCode: true, paths: { queue: "state/queue.json" }, provider: "opencode" }, null, 2)}\n`,
      );

      const context = await loadContext(tempDir, { _: [] });

      expect(context.config).toMatchObject({ allowNestedOpenCode: true, model: defaultModel, provider: "opencode", variant: defaultVariant });
      expect(context.paths.queue).toBe(path.join(tempDir, "state/queue.json"));
    } finally {
      await rm(tempDir, { force: true, recursive: true });
    }
  });

  test("loadContext resolves relative config flags from the project root", async () => {
    const tempDir = await import("node:fs/promises").then((fs) => fs.mkdtemp(path.join(os.tmpdir(), "roadrunner-config-flag-")));
    try {
      await mkdir(path.join(tempDir, "config"), { recursive: true });
      await writeFile(path.join(tempDir, "config/roadrunner.json"), `${JSON.stringify({ allowNestedOpenCode: true, paths: { queue: "state/queue.json" } }, null, 2)}\n`);

      const context = await loadContext(tempDir, { _: [], config: "config/roadrunner.json" });

      expect(context.paths.config).toBe(path.join(tempDir, "config/roadrunner.json"));
      expect(context.paths.queue).toBe(path.join(tempDir, "state/queue.json"));
      expect(context.config.allowNestedOpenCode).toBe(true);
    } finally {
      await rm(tempDir, { force: true, recursive: true });
    }
  });

  test("readJson, writeJson, and pathExists handle files", async () => {
    const tempDir = await import("node:fs/promises").then((fs) => fs.mkdtemp(path.join(os.tmpdir(), "roadrunner-json-")));
    try {
      const filePath = path.join(tempDir, "nested/value.json");

      expect(await pathExists(filePath)).toBe(false);
      await writeJson(filePath, { ok: true });

      expect(await pathExists(filePath)).toBe(true);
      expect(await readJson(filePath)).toEqual({ ok: true });
      expect(await readFile(filePath, "utf8")).toBe(`${JSON.stringify({ ok: true }, null, 2)}\n`);
    } finally {
      await rm(tempDir, { force: true, recursive: true });
    }
  });
});
