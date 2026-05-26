import { describe, expect, test } from "vitest";

import { createCapturedOutputBuffer } from "../src/infrastructure/captured-output.js";

describe("captured output buffer", () => {
  test("keeps output unchanged while under the cap", () => {
    const output = createCapturedOutputBuffer("10");

    output.append("abc");

    expect(output.value()).toBe("abc");
  });

  test("rejects invalid captured output caps", () => {
    expect(() => createCapturedOutputBuffer("bad")).toThrow(/ROADRUNNER_MAX_CAPTURED_OUTPUT_BYTES/);
    expect(() => createCapturedOutputBuffer("-1")).toThrow(/ROADRUNNER_MAX_CAPTURED_OUTPUT_BYTES/);
    expect(() => createCapturedOutputBuffer("0")).toThrow(/ROADRUNNER_MAX_CAPTURED_OUTPUT_BYTES/);
  });

  test("trims partial utf8 characters after truncation", () => {
    const output = createCapturedOutputBuffer("1");

    output.append("é");

    expect(output.value()).toBe("[Output truncated to last 1 bytes]\n");
  });
});
