import { once } from "node:events";
import { chmod, readFile, stat, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, test } from "vitest";

import { loadContext } from "../src/infrastructure/config.js";
import { createLogDir, createPrivateWriteStream, renderPrompt, writePrivateFile } from "../src/infrastructure/run-artifacts.js";
import { removeDir, tempDir } from "./helpers.js";

describe("run artifacts", () => {
  test("creates unique log directories with the task suffix", async () => {
    const directory = await tempDir("roadrunner-artifacts-log-dir-");
    try {
      const context = await loadContext(directory, { _: [] });

      const first = await createLogDir(context, "first-step");
      const second = await createLogDir(context, "first-step");

      expect(first).not.toBe(second);
      expect(path.basename(first)).toMatch(/-first-step$/);
      expect(path.basename(second)).toMatch(/-first-step$/);
    } finally {
      await removeDir(directory);
    }
  });

  test("creates private streams with restrictive permissions on existing files", async () => {
    const directory = await tempDir("roadrunner-artifacts-stream-");
    try {
      const filePath = path.join(directory, "provider.log");
      await writeFile(filePath, "old\n");
      await chmod(filePath, 0o644);

      const stream = await createPrivateWriteStream(filePath);
      stream.end("secret\n");
      await once(stream, "close");

      expect(await readFile(filePath, "utf8")).toBe("secret\n");
      expect((await stat(filePath)).mode & 0o777).toBe(0o600);
    } finally {
      await removeDir(directory);
    }
  });

  test("refuses to write private files through symlinks", async () => {
    const directory = await tempDir("roadrunner-artifacts-symlink-");
    try {
      const target = path.join(directory, "target.txt");
      const link = path.join(directory, "link.txt");
      await writeFile(target, "target\n");
      await symlink(target, link);

      await expect(writePrivateFile(link, "changed\n")).rejects.toThrow();
      expect(await readFile(target, "utf8")).toBe("target\n");
    } finally {
      await removeDir(directory);
    }
  });

  test("falls back to packaged prompt templates when a project prompt is missing", async () => {
    const directory = await tempDir("roadrunner-artifacts-prompt-fallback-");
    try {
      const context = await loadContext(directory, { _: [] });

      const startupPrompt = await renderPrompt(context, "startup-refresh.md", {
        GOALS_MD: "# Goals",
        QUEUE_JSON: "{}",
        QUEUE_PATH: ".roadrunner/state/queue.json",
        ROADMAP_MD: "# Roadmap",
        ROADMAP_PARSE_STATUS: "parsed",
      });
      const reconcilePrompt = await renderPrompt(context, "reconcile-roadmap.md", {
        GOALS_MD: "# Goals",
        QUEUE_JSON: "{}",
        STEP_JSON: "{}",
      });
      const planPrompt = await renderPrompt(context, "plan-step.md", {
        GOALS_MD: "# Goals",
        ROADMAP_STATUS: "next step",
        STEP_JSON: "{}",
      });

      expect(startupPrompt).toContain("Roadrunner Startup Queue Refresh");
      expect(startupPrompt).toContain("# Goals");
      expect(planPrompt).toContain("use a longer outer fence");
      expect(planPrompt).toContain("````md roadrunner-plan");
      for (const prompt of [startupPrompt, reconcilePrompt]) {
        expect(prompt).toContain("`id`, `phase`, `title`, `scope`, `prompt`, `acceptance`, and `verification`");
        expect(prompt).toContain("not `roadmapPhase`");
        expect(prompt).toContain("not `acceptanceCriteria`");
        expect(prompt).toContain('"phase": "Roadmap phase name"');
        expect(prompt).toContain('"acceptance": ["Observable acceptance criterion."]');
        expect(prompt).toContain("durable repository evidence");
        expect(prompt).toContain("existing gate covers `GOALS.md` and the completed roadmap");
      }
    } finally {
      await removeDir(directory);
    }
  });
});
