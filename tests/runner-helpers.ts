import { readdir, stat } from "node:fs/promises";
import path from "node:path";

import { loadContext, type ProjectContext } from "../src/infrastructure/config.js";
import { commitAll, createFakeOpenCodeBin, createInitializedProject, initGit, sampleRoadmap, tempDir, withPath } from "./helpers.js";

export async function setupRunnerProject(mode: string, roadmap = sampleRoadmap()): Promise<{ context: ProjectContext; directory: string }> {
  const directory = await tempDir("roadrunner-runner-");
  const binDir = await createFakeOpenCodeBin(directory);
  process.env.PATH = withPath(binDir);
  process.env.ROADRUNNER_FAKE_OPENCODE_MODE = mode;
  process.env.ROADRUNNER_TEST_REAL_GIT = "/usr/bin/git";
  delete process.env.OPENCODE_SESSION;
  delete process.env.OPENCODE_SESSION_ID;
  delete process.env.OPENCODE_SERVER;
  delete process.env.OPENCODE_WORKSPACE;
  delete process.env.OPENCODE_APP_INFO;

  await createInitializedProject(directory, roadmap);
  await initGit(directory);
  await commitAll(directory, "Initial project");
  const context = await loadContext(directory, { _: [] });
  context.config.allowNestedOpenCode = true;
  return { context, directory };
}

export function twoStepRoadmap(): string {
  return `${sampleRoadmap()}

## second-step: Build second step

Phase: Bootstrap
Scope: second.txt
Prompt: Keep this future step queued.
Acceptance:
- second step remains queued
Verification:
- node -e "process.exit(0)"
`;
}

export async function fileMode(filePath: string): Promise<number> {
  return (await stat(filePath)).mode & 0o777;
}

export async function logDirFor(context: ProjectContext, suffix: string): Promise<string> {
  const entries = await readdir(context.paths.logs);
  const entry = entries.find((value) => value.endsWith(`-${suffix}`));
  if (!entry) throw new Error(`Missing log dir for ${suffix}.`);
  return path.join(context.paths.logs, entry);
}
