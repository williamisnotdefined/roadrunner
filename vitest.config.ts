import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      all: true,
      exclude: [
        ".cursor/**",
        ".github/instructions/**",
        ".opencode/**",
        "dist/**",
        "node_modules/**",
        "test-output/**",
        "tests/**",
        "vitest.config.ts",
      ],
      include: ["src/**/*.ts"],
      provider: "v8",
      thresholds: {
        branches: 100,
        functions: 100,
        lines: 100,
        statements: 100,
      },
    },
    include: ["tests/**/*.test.ts", "tests/**/*.e2e.test.ts"],
    restoreMocks: true,
  },
});
