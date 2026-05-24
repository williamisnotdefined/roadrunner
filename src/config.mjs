import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const defaultModel = "openai/gpt-5.5";
export const defaultVariant = "xhigh";

export function projectPaths(projectRoot = process.cwd()) {
  return {
    config: path.join(projectRoot, ".roadrunner/config.json"),
    execution: path.join(projectRoot, ".roadrunner/execution.json"),
    goals: path.join(projectRoot, "GOALS.md"),
    lock: path.join(projectRoot, ".roadrunner/roadmap.lock"),
    logs: path.join(projectRoot, ".roadrunner/logs"),
    processRegistry: path.join(projectRoot, ".roadrunner/processes.json"),
    prompts: path.join(projectRoot, ".roadrunner/prompts"),
  };
}

export async function pathExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

export async function writeJson(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

export async function readConfig(projectRoot = process.cwd()) {
  const paths = projectPaths(projectRoot);

  if (!(await pathExists(paths.config))) {
    return {
      provider: "opencode",
      model: defaultModel,
      variant: defaultVariant,
    };
  }

  return readJson(paths.config);
}
