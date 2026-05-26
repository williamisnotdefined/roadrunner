import { describe, expect, test } from "vitest";

import { errorMessage, formatContextualError } from "../src/application/error-message.js";

describe("error message helpers", () => {
  test("formats contextual errors with optional details and logs", () => {
    expect(formatContextualError("Plain failure")).toBe("Plain failure");
    expect(formatContextualError("Detailed failure", ["first", "second"], "run.log")).toBe("Detailed failure\n\nDetails:\nfirst\nsecond\n\nLog:\nrun.log");
  });

  test("normalizes thrown and non-error values", () => {
    expect(errorMessage(new Error("boom"))).toBe("boom");
    expect(errorMessage("plain")).toBe("plain");
  });
});
