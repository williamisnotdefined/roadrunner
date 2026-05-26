import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import { loadContext } from "../src/infrastructure/config.js";
import { OpenCodeProvider, validateOpenCodeCli } from "../src/infrastructure/providers/opencode.js";
import { createFakeOpenCodeBin, removeDir, tempDir, withPath } from "./helpers.js";

const oldEnv = { ...process.env };

afterEach(() => {
  process.env = { ...oldEnv };
});

describe("OpenCodeProvider validation", () => {
  test("validates OpenCode run help flags", async () => {
    const directory = await tempDir("roadrunner-provider-validate-");
    try {
      const binDir = await createFakeOpenCodeBin(directory);
      process.env.PATH = withPath(binDir);

      expect(await validateOpenCodeCli()).toEqual([]);
    } finally {
      await removeDir(directory);
    }
  });

  test("reports missing OpenCode command and missing run flags", async () => {
    const directory = await tempDir("roadrunner-provider-validate-error-");
    try {
      process.env.PATH = directory;
      expect(await validateOpenCodeCli()).toEqual(["opencode must be installed and available in PATH."]);

      const binDir = path.join(directory, "bin");
      await mkdir(binDir, { recursive: true });
      await writeFile(path.join(binDir, "opencode"), "#!/usr/bin/env node\nconsole.log('--model');\n", { mode: 0o755 });
      process.env.PATH = `${binDir}${path.delimiter}${oldEnv.PATH ?? ""}`;

      expect(await validateOpenCodeCli()).toEqual([
        "opencode run --help is missing required flag --variant.",
        "opencode run --help is missing required flag --agent.",
        "opencode run --help is missing required flag --file.",
        "opencode run --help is missing required flag --dangerously-skip-permissions.",
      ]);

      await writeFile(path.join(binDir, "opencode"), "#!/usr/bin/env node\nconsole.log('--modeling --variant-name --agentic --filename --dangerously-skip-permissions-extra');\n", { mode: 0o755 });
      expect(await validateOpenCodeCli()).toEqual([
        "opencode run --help is missing required flag --model.",
        "opencode run --help is missing required flag --variant.",
        "opencode run --help is missing required flag --agent.",
        "opencode run --help is missing required flag --file.",
        "opencode run --help is missing required flag --dangerously-skip-permissions.",
      ]);

      await writeFile(path.join(binDir, "opencode"), "#!/usr/bin/env node\nconsole.error('bad help');\nprocess.exit(2);\n", { mode: 0o755 });
      expect((await validateOpenCodeCli())[0]).toMatch(/opencode run --help failed/);

      await writeFile(path.join(binDir, "opencode"), "#!/usr/bin/env node\nif (process.argv.includes('--help')) setInterval(() => {}, 1000);\n", { mode: 0o755 });
      process.env.ROADRUNNER_OPENCODE_CHECK_TIMEOUT_MS = "50";
      expect(await validateOpenCodeCli()).toEqual(["opencode run --help timed out after 50 ms."]);

      process.env.ROADRUNNER_OPENCODE_CHECK_TIMEOUT_MS = "nope";
      expect(await validateOpenCodeCli()).toEqual(["ROADRUNNER_OPENCODE_CHECK_TIMEOUT_MS must be a positive integer, got nope."]);
    } finally {
      await removeDir(directory);
    }
  });

  test("does not pass arbitrary parent environment variables to OpenCode", async () => {
    const directory = await tempDir("roadrunner-provider-env-filter-");
    const oldSecret = process.env.UNTRUSTED_SECRET;
    try {
      const binDir = path.join(directory, "bin");
      const envFile = path.join(directory, "env.txt");
      await mkdir(binDir, { recursive: true });
      await writeFile(
        path.join(binDir, "opencode"),
        `#!/usr/bin/env node\nif (process.argv.includes('--help')) { console.log('--model --variant --agent --file --dangerously-skip-permissions'); process.exit(0); }\nrequire('node:fs').writeFileSync(${JSON.stringify(envFile)}, process.env.UNTRUSTED_SECRET || 'missing');\nconsole.log('ok');\n`,
        { mode: 0o755 },
      );
      process.env.PATH = withPath(binDir);
      process.env.UNTRUSTED_SECRET = "secret";
      const context = await loadContext(directory, { _: [] });
      context.config.allowNestedOpenCode = true;

      const result = await new OpenCodeProvider().run({
        agent: "plan",
        context,
        logPath: path.join(directory, "env-filter.log"),
        prompt: "Roadrunner Plan Step",
        role: "plan",
        workspaceAccess: "read-only",
      });

      expect(result.code).toBe(0);
      expect(await readFile(envFile, "utf8")).toBe("missing");
    } finally {
      if (oldSecret === undefined) delete process.env.UNTRUSTED_SECRET;
      else process.env.UNTRUSTED_SECRET = oldSecret;
      await removeDir(directory);
    }
  });
});
