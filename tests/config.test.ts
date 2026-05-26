import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";

import { pathOverridesFromArgs } from "../src/cli/args.js";
import { defaultModel, defaultVariant, loadContext, packageRootFromSourceRoot, pathExists, projectPaths, readJson, writeJson } from "../src/infrastructure/config.js";

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

  test("loadContext ignores generated legacy queue paths", async () => {
    const tempDir = await import("node:fs/promises").then((fs) => fs.mkdtemp(path.join(os.tmpdir(), "roadrunner-config-legacy-")));
    try {
      await mkdir(path.join(tempDir, ".roadrunner"), { recursive: true });
      await writeFile(path.join(tempDir, ".roadrunner/config.json"), `${JSON.stringify({ paths: { queue: ".roadrunner/queue.json" } }, null, 2)}\n`);

      const context = await loadContext(tempDir, { _: [] });

      expect(context.paths.config).toBe(path.join(tempDir, ".roadrunner/config.json"));
    } finally {
      await rm(tempDir, { force: true, recursive: true });
    }
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
      roadmap: "ROADMAP.md",
    });
  });

  test("loadContext uses defaults and nested config", async () => {
    const tempDir = await import("node:fs/promises").then((fs) => fs.mkdtemp(path.join(os.tmpdir(), "roadrunner-config-default-")));
    try {
      await mkdir(path.join(tempDir, ".roadrunner"), { recursive: true });
      await writeFile(
        path.join(tempDir, ".roadrunner/config.json"),
        `${JSON.stringify({ allowNestedOpenCode: true, paths: { logs: "logs" }, provider: "opencode" }, null, 2)}\n`,
      );

      const context = await loadContext(tempDir, { _: [] });

      expect(context.config).toMatchObject({
        allowNestedOpenCode: true,
        autoRestartIdleMs: 600000,
        dangerouslySkipPermissions: false,
        maxAutoRestartsPerStep: 10,
        model: defaultModel,
        provider: "opencode",
        variant: defaultVariant,
      });
      expect(context.paths.logs).toBe(path.join(tempDir, "logs"));
    } finally {
      await rm(tempDir, { force: true, recursive: true });
    }
  });

  test("loadContext resolves relative config flags from the project root", async () => {
    const tempDir = await import("node:fs/promises").then((fs) => fs.mkdtemp(path.join(os.tmpdir(), "roadrunner-config-flag-")));
    try {
      await mkdir(path.join(tempDir, "config"), { recursive: true });
      await writeFile(
        path.join(tempDir, "config/roadrunner.json"),
        `${JSON.stringify({ allowNestedOpenCode: true, autoRestartIdleMs: 42, dangerouslySkipPermissions: true, maxAutoRestartsPerStep: 5, paths: { logs: "logs" } }, null, 2)}\n`,
      );

      const context = await loadContext(tempDir, { _: [], config: "config/roadrunner.json" });

      expect(context.paths.config).toBe(path.join(tempDir, "config/roadrunner.json"));
      expect(context.paths.logs).toBe(path.join(tempDir, "logs"));
      expect(context.config.allowNestedOpenCode).toBe(true);
      expect(context.config.autoRestartIdleMs).toBe(42);
      expect(context.config.dangerouslySkipPermissions).toBe(true);
      expect(context.config.maxAutoRestartsPerStep).toBe(5);
    } finally {
      await rm(tempDir, { force: true, recursive: true });
    }
  });

  test("loadContext rejects invalid config values", async () => {
    const tempDir = await import("node:fs/promises").then((fs) => fs.mkdtemp(path.join(os.tmpdir(), "roadrunner-config-invalid-")));
    try {
      const configPath = path.join(tempDir, ".roadrunner/config.json");
      await mkdir(path.dirname(configPath), { recursive: true });

      const cases: Array<{ match: RegExp; value: unknown }> = [
        { value: [], match: /must be a JSON object/ },
        { value: { allowNestedOpenCode: "true" }, match: /allowNestedOpenCode must be a boolean/ },
        { value: { allowedVerificationCommands: ["npm test", ""] }, match: /allowedVerificationCommands\[1\] must be an exact non-empty command string/ },
        { value: { allowedVerificationCommands: "npm test" }, match: /allowedVerificationCommands must be an array of exact non-empty command strings/ },
        { value: { dangerouslySkipPermissions: "false" }, match: /dangerouslySkipPermissions must be a boolean/ },
        { value: { autoRestartIdleMs: -1 }, match: /autoRestartIdleMs must be a non-negative integer/ },
        { value: { maxAutoRestartsPerStep: 1.5 }, match: /maxAutoRestartsPerStep must be a non-negative integer/ },
        { value: { model: 123 }, match: /model must be a non-empty string/ },
        { value: { paths: [] }, match: /paths must be a JSON object/ },
        { value: { paths: { queue: false } }, match: /paths\.queue must be a non-empty string/ },
        { value: { paths: { unknown: "value" } }, match: /paths\.unknown is not a supported path key/ },
        { value: { unknown: true }, match: /unknown is not a supported config key/ },
      ];

      for (const { value, match } of cases) {
        await writeFile(configPath, `${JSON.stringify(value, null, 2)}\n`);
        await expect(loadContext(tempDir, { _: [] })).rejects.toThrow(match);
      }

      await writeFile(configPath, "{not json\n");
      await expect(loadContext(tempDir, { _: [] })).rejects.toThrow(/Failed to read Roadrunner config/);
      await expect(loadContext(tempDir, { _: [] })).rejects.toThrow(/not valid JSON/);
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
