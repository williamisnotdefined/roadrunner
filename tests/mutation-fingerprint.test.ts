import { mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";

import { loadContext } from "../src/config.js";
import { parseStatusEntries, parseStatusPaths, projectMutationFingerprint } from "../src/mutation-fingerprint.js";

describe("mutation fingerprint", () => {
  test("parses git status paths including renames", () => {
    expect(parseStatusPaths(" M file.txt\nR  old.txt -> new.txt\n")).toEqual(["file.txt", "new.txt"]);
    expect(parseStatusPaths(" M file with spaces.txt\0R  new name.txt\0old name.txt\0C  copy.txt\0source.txt\0?? weird -> name.txt\0")).toEqual([
      "file with spaces.txt",
      "new name.txt",
      "copy.txt",
      "weird -> name.txt",
    ]);
    expect(parseStatusEntries(" M file.txt\nR  old.txt -> new.txt\n")).toEqual([
      { path: "file.txt", status: " M" },
      { path: "new.txt", status: "R " },
    ]);
  });

  test("can ignore allowed mutation paths outside git repositories", async () => {
    const directory = await import("node:fs/promises").then((fs) => fs.mkdtemp(path.join(os.tmpdir(), "roadrunner-fingerprint-ignore-")));
    try {
      await mkdir(path.join(directory, ".roadrunner"), { recursive: true });
      const context = await loadContext(directory, { _: [] });
      await writeFile(context.paths.queue, "before\n");
      const before = await projectMutationFingerprint(context, { ignoredPaths: [context.paths.queue] });

      await writeFile(context.paths.queue, "after\n");
      expect(await projectMutationFingerprint(context, { ignoredPaths: [context.paths.queue] })).toBe(before);

      await writeFile(path.join(directory, "unexpected.txt"), "changed\n");
      expect(await projectMutationFingerprint(context, { ignoredPaths: [context.paths.queue] })).not.toBe(before);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });
});
