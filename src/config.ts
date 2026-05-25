import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { type CliArgs, stringOption } from "./args.js";
import { defaultAutoRestartIdleMs, defaultMaxAutoRestartsPerStep } from "./restart-policy.js";

export const defaultModel = "openai/gpt-5.5";
export const defaultVariant = "xhigh";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const sourceRoot = path.resolve(moduleDir, "..");
export const packageRoot = packageRootFromSourceRoot(sourceRoot);

export function packageRootFromSourceRoot(sourceRootPath: string): string {
  return path.basename(sourceRootPath) === "dist" ? path.resolve(sourceRootPath, "..") : sourceRootPath;
}

export interface PathOverrides {
  config?: string;
  goals?: string;
  goal?: string;
  lock?: string;
  logs?: string;
  processes?: string;
  prompts?: string;
  queue?: string;
  roadmap?: string;
}

export interface ProjectPaths {
  config: string;
  goals: string;
  lock: string;
  logs: string;
  processRegistry: string;
  prompts: string;
  queue: string;
  roadmap: string;
}

export interface RoadrunnerConfig {
  allowNestedOpenCode?: boolean;
  autoRestartIdleMs?: number;
  dangerouslySkipPermissions?: boolean;
  maxAutoRestartsPerStep?: number;
  provider?: string;
  model?: string;
  variant?: string;
  paths?: PathOverrides;
}

export interface ProjectContext {
  config: Required<Pick<RoadrunnerConfig, "provider" | "model" | "variant">> & {
    allowNestedOpenCode: boolean;
    autoRestartIdleMs: number;
    dangerouslySkipPermissions: boolean;
    maxAutoRestartsPerStep: number;
    paths?: PathOverrides;
  };
  paths: ProjectPaths;
  root: string;
}

export function projectPaths(projectRoot = process.cwd(), overrides: PathOverrides = {}): ProjectPaths {
  return {
    config: resolveProjectPath(projectRoot, overrides.config ?? ".roadrunner/config.json"),
    goals: resolveProjectPath(projectRoot, overrides.goals ?? overrides.goal ?? "GOALS.md"),
    lock: resolveProjectPath(projectRoot, overrides.lock ?? ".roadrunner/roadmap.lock"),
    logs: resolveProjectPath(projectRoot, overrides.logs ?? ".roadrunner/logs"),
    processRegistry: resolveProjectPath(projectRoot, overrides.processes ?? ".roadrunner/processes.json"),
    prompts: resolveProjectPath(projectRoot, overrides.prompts ?? ".roadrunner/prompts"),
    queue: resolveProjectPath(projectRoot, overrides.queue ?? ".roadrunner/queue.json"),
    roadmap: resolveProjectPath(projectRoot, overrides.roadmap ?? "ROADMAP.md"),
  };
}

export async function loadContext(projectRoot = process.cwd(), args: CliArgs = { _: [] }): Promise<ProjectContext> {
  const flagOverrides = pathOverridesFromArgs(args);
  const configPath = flagOverrides.config ? resolveProjectPath(projectRoot, flagOverrides.config) : await defaultConfigPath(projectRoot);
  const fileConfig = (await pathExists(configPath)) ? await readConfig(configPath) : {};
  const paths = projectPaths(projectRoot, { ...fileConfig.paths, ...flagOverrides, config: configPath });

  return {
    config: {
      allowNestedOpenCode: fileConfig.allowNestedOpenCode ?? false,
      autoRestartIdleMs: fileConfig.autoRestartIdleMs ?? defaultAutoRestartIdleMs,
      dangerouslySkipPermissions: fileConfig.dangerouslySkipPermissions ?? false,
      maxAutoRestartsPerStep: fileConfig.maxAutoRestartsPerStep ?? defaultMaxAutoRestartsPerStep,
      provider: fileConfig.provider ?? "opencode",
      model: fileConfig.model ?? defaultModel,
      variant: fileConfig.variant ?? defaultVariant,
      paths: fileConfig.paths,
    },
    paths,
    root: projectRoot,
  };
}

export function pathOverridesFromArgs(args: CliArgs): PathOverrides {
  const overrides: PathOverrides = {};
  const options: Array<[keyof PathOverrides, unknown]> = [
    ["config", args.config],
    ["goals", args.goals],
    ["goal", args.goal],
    ["lock", args.lock],
    ["logs", args.logs],
    ["processes", args.processes],
    ["prompts", args.prompts],
    ["queue", args.queue],
    ["roadmap", args.roadmap],
  ];

  for (const [key, value] of options) {
    const option = stringOption(value);
    if (option !== undefined) overrides[key] = option;
  }

  return overrides;
}

export async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function readJson<T = unknown>(filePath: string): Promise<T> {
  return JSON.parse(await readFile(filePath, "utf8")) as T;
}

export function validateRoadrunnerConfig(value: unknown, filePath = "Roadrunner config"): string[] {
  const errors: string[] = [];
  if (!isRecord(value)) return [`${filePath} must be a JSON object.`];

  const allowedConfigKeys = new Set(["allowNestedOpenCode", "autoRestartIdleMs", "dangerouslySkipPermissions", "maxAutoRestartsPerStep", "provider", "model", "variant", "paths"]);
  for (const key of Object.keys(value)) {
    if (!allowedConfigKeys.has(key)) errors.push(`${filePath}.${key} is not a supported config key.`);
  }

  for (const key of ["allowNestedOpenCode", "dangerouslySkipPermissions"] as const) {
    if (value[key] !== undefined && typeof value[key] !== "boolean") errors.push(`${filePath}.${key} must be a boolean.`);
  }

  for (const key of ["provider", "model", "variant"] as const) {
    if (value[key] !== undefined && (typeof value[key] !== "string" || value[key].length === 0)) errors.push(`${filePath}.${key} must be a non-empty string.`);
  }

  for (const key of ["autoRestartIdleMs", "maxAutoRestartsPerStep"] as const) {
    const numericValue = value[key];
    if (numericValue !== undefined && (typeof numericValue !== "number" || !Number.isSafeInteger(numericValue) || numericValue < 0)) errors.push(`${filePath}.${key} must be a non-negative integer.`);
  }

  if (value.paths !== undefined) {
    if (!isRecord(value.paths)) {
      errors.push(`${filePath}.paths must be a JSON object.`);
    } else {
      const allowedPathKeys = new Set(["config", "goals", "goal", "lock", "logs", "processes", "prompts", "queue", "roadmap"]);
      for (const [key, pathValue] of Object.entries(value.paths)) {
        if (!allowedPathKeys.has(key)) {
          errors.push(`${filePath}.paths.${key} is not a supported path key.`);
          continue;
        }
        if (typeof pathValue !== "string" || pathValue.length === 0) errors.push(`${filePath}.paths.${key} must be a non-empty string.`);
      }
    }
  }

  return errors;
}

export async function writeJson(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function readConfig(filePath: string): Promise<RoadrunnerConfig> {
  const value = await readJson<unknown>(filePath);
  const errors = validateRoadrunnerConfig(value, filePath);
  if (errors.length > 0) throw new Error(errors.join("\n"));
  return value as RoadrunnerConfig;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function resolveProjectPath(projectRoot: string, filePath: string): string {
  return path.isAbsolute(filePath) ? filePath : path.resolve(projectRoot, filePath);
}

async function defaultConfigPath(projectRoot: string): Promise<string> {
  const rootConfig = resolveProjectPath(projectRoot, "roadrunner.config.json");
  if (await pathExists(rootConfig)) return rootConfig;
  return resolveProjectPath(projectRoot, ".roadrunner/config.json");
}
