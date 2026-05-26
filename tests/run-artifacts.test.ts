import { once } from "node:events";
import { chmod, readFile, stat, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, test } from "vitest";

import { loadContext } from "../src/infrastructure/config.js";
import { createPrivateWriteStream, renderPrompt, writePrivateFile } from "../src/infrastructure/run-artifacts.js";
import { removeDir, tempDir } from "./helpers.js";

const testSymlink = process.platform === "win32" ? test.skip : test;

describe("run artifacts", () => {
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

  testSymlink("refuses to write private files through symlinks", async () => {
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

      const prompt = await renderPrompt(context, "startup-refresh.md", {
        GOALS_MD: "# Goals",
        QUEUE_JSON: "{}",
        QUEUE_PATH: ".roadrunner/state/queue.json",
        ROADMAP_MD: "# Roadmap",
        ROADMAP_PARSE_STATUS: "parsed",
      });

      expect(prompt).toContain("Roadrunner Startup Queue Refresh");
      expect(prompt).toContain("# Goals");
    } finally {
      await removeDir(directory);
    }
  });
});
