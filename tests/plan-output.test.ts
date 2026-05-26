import { describe, expect, test } from "vitest";

import { PlanOutputError, planMarkdownFromOutput } from "../src/application/plan-output.js";

describe("plan output", () => {
  test("extracts the single clean Roadrunner plan block", () => {
    const output = `tool trace

\`\`\`md roadrunner-plan
## Goal Alignment
Implement the step.
\`\`\`
`;

    expect(planMarkdownFromOutput(output)).toBe("## Goal Alignment\nImplement the step.");
  });

  test("supports longer outer fences around nested command blocks", () => {
    const output = `tool trace

\`\`\`\`md roadrunner-plan
## Roadrunner Verification Commands

\`\`\`bash
npm test
\`\`\`
\`\`\`\`
`;

    expect(planMarkdownFromOutput(output)).toBe("## Roadrunner Verification Commands\n\n```bash\nnpm test\n```");
  });

  test("rejects missing, duplicate, and empty plan blocks", () => {
    expect(() => planMarkdownFromOutput("Plan without block")).toThrow(PlanOutputError);
    expect(() =>
      planMarkdownFromOutput(`\`\`\`md roadrunner-plan
first
\`\`\`
\`\`\`md roadrunner-plan
second
\`\`\``),
    ).toThrow(/exactly one/);
    expect(() =>
      planMarkdownFromOutput(`\`\`\`md roadrunner-plan

\`\`\``),
    ).toThrow(/must not be empty/);
  });

  test("rejects truncated plans caused by nested fences with the same length", () => {
    expect(() =>
      planMarkdownFromOutput(`\`\`\`md roadrunner-plan
## Roadrunner Verification Commands

\`\`\`bash
npm test
\`\`\`
\`\`\``),
    ).toThrow(/unclosed nested fence/);
  });
});
