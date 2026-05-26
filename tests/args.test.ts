import { describe, expect, test } from "vitest";

import { integerOption, numberOption, optionalNumberOption, parseArgs, stringOption } from "../src/cli/args.js";

describe("args", () => {
  test("parses positional args, inline values, separated values, and booleans", () => {
    expect(parseArgs(["run", "--max-steps=3", "--goals", "GOALS.md", "--force"])).toEqual({
      _: ["run"],
      force: true,
      goals: "GOALS.md",
      "max-steps": "3",
    });
  });

  test("keeps next flag as boolean when value is absent", () => {
    expect(parseArgs(["--force", "--goals"])).toEqual({ _: [], force: true, goals: true });
  });

  test("ignores empty flag names", () => {
    expect(parseArgs(["--", "next"])).toEqual({ _: ["next"] });
  });

  test("normalizes string options", () => {
    expect(stringOption("value")).toBe("value");
    expect(stringOption("")).toBeUndefined();
    expect(stringOption(true)).toBeUndefined();
  });

  test("parses required positive numbers", () => {
    expect(numberOption(undefined, 4)).toBe(4);
    expect(numberOption(true, 5)).toBe(5);
    expect(numberOption("2", 1)).toBe(2);
    expect(() => numberOption("0", 1)).toThrow(/Expected a positive number/);
    expect(() => numberOption("nope", 1)).toThrow(/Expected a positive number/);
  });

  test("parses optional positive numbers", () => {
    expect(optionalNumberOption(undefined)).toBeUndefined();
    expect(optionalNumberOption("1.5")).toBe(1.5);
    expect(() => optionalNumberOption(true)).toThrow(/got true/);
  });

  test("parses required positive integers", () => {
    expect(integerOption(undefined, 4)).toBe(4);
    expect(integerOption("2", 1)).toBe(2);
    expect(() => integerOption("1.5", 1)).toThrow(/positive integer/);
  });
});
