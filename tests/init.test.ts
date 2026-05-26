import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";

import { loadContext, pathExists } from "../src/infrastructure/config.js";
import { initProject } from "../src/application/init.js";

describe("init", () => {
  test("initProject creates Roadrunner project files", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "roadrunner-init-"));
    try {
      const context = await loadContext(tempDir, { _: [] });
      await initProject(context);
      const { paths } = context;

      expect(await pathExists(paths.goals)).toBe(true);
      expect(await pathExists(paths.config)).toBe(true);
      expect(await pathExists(path.join(path.dirname(paths.config), ".gitignore"))).toBe(true);
      expect(await pathExists(path.join(paths.prompts, "plan-step.md"))).toBe(true);
      expect(await readFile(paths.goals, "utf8")).toMatch(/Plan -> Execute -> Verify -> Reconcile/);
      expect(await readFile(path.join(path.dirname(paths.config), ".gitignore"), "utf8")).toMatch(/logs\//);
    } finally {
      await rm(tempDir, { force: true, recursive: true });
    }
  });

  test("initProject creates nested goal paths without runtime queue files", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "roadrunner-init-nested-"));
    try {
      const context = await loadContext(tempDir, { _: [], goals: "docs/GOALS.md" });

      await initProject(context);

      expect(await pathExists(path.join(tempDir, "docs/GOALS.md"))).toBe(true);
    } finally {
      await rm(tempDir, { force: true, recursive: true });
    }
  });

  test("initProject ignores customized runtime paths", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "roadrunner-init-runtime-ignore-"));
    try {
      const context = await loadContext(tempDir, { _: [], lock: "state/road.lock", logs: "custom-logs", processes: "state/processes.json" });
      await writeFile(path.join(tempDir, ".gitignore"), "existing-ignore");

      await initProject(context);

      const gitignore = await readFile(path.join(tempDir, ".gitignore"), "utf8");
      expect(gitignore).toMatch(/existing-ignore/);
      expect(gitignore).toMatch(/custom-logs\//);
      expect(gitignore).toMatch(/state\/processes\.json/);
      expect(gitignore).toMatch(/state\/road\.lock/);
    } finally {
      await rm(tempDir, { force: true, recursive: true });
    }
  });

  test("initProject leaves roadmap import to run startup", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "roadrunner-init-roadmap-"));
    try {
      await writeFile(
        path.join(tempDir, "ROADMAP.md"),
        `# Roadmap

## first-step: Build first step

Phase: Bootstrap
Scope: README.md
Prompt: Implement the first concrete step.
Acceptance:
- docs explain the behavior
Verification:
- npm run check
`,
      );
      const context = await loadContext(tempDir, { _: [] });

      await initProject(context);

      expect(await pathExists(path.join(tempDir, ".roadrunner/state/queue.json"))).toBe(false);
    } finally {
      await rm(tempDir, { force: true, recursive: true });
    }
  });

  test("initProject does not overwrite customized prompts", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "roadrunner-init-prompts-"));
    try {
      const context = await loadContext(tempDir, { _: [] });
      await initProject(context);
      const promptPath = path.join(context.paths.prompts, "plan-step.md");
      await writeFile(promptPath, "custom prompt\n");

      await initProject(context);

      expect(await readFile(promptPath, "utf8")).toBe("custom prompt\n");
    } finally {
      await rm(tempDir, { force: true, recursive: true });
    }
  });

  test("loadContext reads root Roadrunner config by default", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "roadrunner-config-"));
    try {
      await writeFile(path.join(tempDir, "roadrunner.config.json"), `${JSON.stringify({ paths: { logs: "ai/logs" } }, null, 2)}\n`);

      const context = await loadContext(tempDir, { _: [] });

      expect(context.paths.config).toBe(path.join(tempDir, "roadrunner.config.json"));
      expect(context.paths.logs).toBe(path.join(tempDir, "ai/logs"));
    } finally {
      await rm(tempDir, { force: true, recursive: true });
    }
  });

  test("initProject preserves root README and configured model", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "roadrunner-init-root-readme-"));
    try {
      await writeFile(path.join(tempDir, "README.md"), "# Target Project\n");
      await writeFile(path.join(tempDir, "roadrunner.config.json"), `${JSON.stringify({ model: "custom-model", variant: "low" }, null, 2)}\n`);
      const context = await loadContext(tempDir, { _: [] });

      await initProject(context);

      expect(await readFile(path.join(tempDir, "README.md"), "utf8")).toBe("# Target Project\n");
      expect(context.config.model).toBe("custom-model");
      expect(context.config.variant).toBe("low");
    } finally {
      await rm(tempDir, { force: true, recursive: true });
    }
  });
});
