import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      all: true,
      exclude: [".cursor/**", ".github/instructions/**", ".opencode/**", "dist/**", "node_modules/**", "test-output/**", "tests/**", "vitest.config.ts"],
      include: ["src/**/*.ts"],
      provider: "v8",
      thresholds: {
        branches: 95,
        functions: 95,
        lines: 95,
        statements: 95,
      },
    },
    include: ["tests/**/*.test.ts", "tests/**/*.e2e.test.ts"],
    restoreMocks: true,
  },
});
