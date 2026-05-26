import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, test } from "vitest";

import { pathExists } from "../src/infrastructure/config.js";
import { upsertRoadrunnerGitignore } from "../src/infrastructure/gitignore.js";
import { removeDir, tempDir } from "./helpers.js";

describe("gitignore helpers", () => {
  test("skips empty runtime entries", async () => {
    const directory = await tempDir("roadrunner-gitignore-empty-");
    try {
      const gitignore = path.join(directory, ".gitignore");

      await upsertRoadrunnerGitignore(gitignore, [""]);

      expect(await pathExists(gitignore)).toBe(false);
    } finally {
      await removeDir(directory);
    }
  });

  test("merges runtime entries into an existing block", async () => {
    const directory = await tempDir("roadrunner-gitignore-merge-");
    try {
      const gitignore = path.join(directory, ".gitignore");

      await upsertRoadrunnerGitignore(gitignore, ["logs/"]);
      await upsertRoadrunnerGitignore(gitignore, ["state/", "logs/"]);

      expect(await readFile(gitignore, "utf8")).toContain("logs/\nstate/");
    } finally {
      await removeDir(directory);
    }
  });
});
