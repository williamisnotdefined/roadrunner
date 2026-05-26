import { describe, expect, test } from "vitest";

import { main } from "../src/cli/index.js";
import { shouldPrintHelp, validateCliInvocation } from "../src/cli/validation.js";
import { createInitializedProject, removeDir, tempDir } from "./helpers.js";

describe("cli validation", () => {
  test("validates help and option value shapes", () => {
    expect(shouldPrintHelp({ _: [] }, "help")).toBe(true);
    expect(shouldPrintHelp({ _: ["run"], help: true }, "run")).toBe(true);
    expect(shouldPrintHelp({ _: ["run"] }, "run")).toBe(false);
    expect(validateCliInvocation("cleanup", { _: ["cleanup"], force: "true" })).toEqual(["Option --force does not take a value."]);
    expect(validateCliInvocation("run", { _: ["run"], "max-steps": true })).toEqual(["Expected a value for --max-steps. Example: --max-steps <value>."]);
    expect(validateCliInvocation("run", { _: ["run"], queue: "state/queue.json" })).toEqual(["Unsupported option for run: --queue. Run roadrunner run --help to see supported options."]);
  });

  test("rejects unknown commands without loading project config", async () => {
    const directory = await tempDir("roadrunner-cli-unknown-");
    const errors: string[] = [];
    try {
      expect(await main(["statuz"], { cwd: directory, io: { stderr: (message) => errors.push(message) } })).toBe(1);
      expect(errors.join("\n")).toMatch(/Unknown command: statuz/);
    } finally {
      await removeDir(directory);
    }
  });

  test("rejects unsupported options, missing values, and extra positionals", async () => {
    const directory = await tempDir("roadrunner-cli-invalid-options-");
    const errors: string[] = [];
    try {
      await createInitializedProject(directory);

      expect(await main(["run", "--max-step", "2"], { cwd: directory, io: { stderr: (message) => errors.push(message) } })).toBe(1);
      expect(await main(["run", "--max-steps"], { cwd: directory, io: { stderr: (message) => errors.push(message) } })).toBe(1);
      expect(await main(["status", "extra"], { cwd: directory, io: { stderr: (message) => errors.push(message) } })).toBe(1);

      expect(errors.join("\n")).toMatch(/Unsupported option for run: --max-step/);
      expect(errors.join("\n")).toMatch(/Expected a value for --max-steps/);
      expect(errors.join("\n")).toMatch(/Unexpected positional argument: extra/);
    } finally {
      await removeDir(directory);
    }
  });
});
