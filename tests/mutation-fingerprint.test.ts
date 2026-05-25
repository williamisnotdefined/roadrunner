import { describe, expect, test } from "vitest";

import { parseStatusEntries, parseStatusPaths } from "../src/mutation-fingerprint.js";

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
});
