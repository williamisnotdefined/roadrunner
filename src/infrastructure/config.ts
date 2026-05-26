import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { defaultModel, defaultVariant } from "../domain/provider-defaults.js";
import { defaultAutoRestartIdleMs, defaultMaxAutoRestartsPerStep } from "../domain/restart-policy.js";

export { defaultModel, defaultVariant } from "../domain/provider-defaults.js";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const sourceRoot = path.resolve(moduleDir, "../..");
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
  /** @deprecated Autonomous run queues are in-memory; retained only to tolerate older config files. */
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

type LoadContextOverrides = PathOverrides & { _?: unknown };

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

type Validator = (value: unknown, path: string) => string[];

const configValidators = {
  allowNestedOpenCode: booleanValidator,
  autoRestartIdleMs: nonNegativeIntegerValidator,
  dangerouslySkipPermissions: booleanValidator,
  maxAutoRestartsPerStep: nonNegativeIntegerValidator,
  model: nonEmptyStringValidator,
  paths: pathsValidator,
  provider: nonEmptyStringValidator,
  variant: nonEmptyStringValidator,
} satisfies Record<string, Validator>;

const pathValidators = {
  config: nonEmptyStringValidator,
  goal: nonEmptyStringValidator,
  goals: nonEmptyStringValidator,
  lock: nonEmptyStringValidator,
  logs: nonEmptyStringValidator,
  processes: nonEmptyStringValidator,
  prompts: nonEmptyStringValidator,
  queue: nonEmptyStringValidator,
  roadmap: nonEmptyStringValidator,
} satisfies Record<string, Validator>;

export function projectPaths(projectRoot = process.cwd(), overrides: PathOverrides = {}): ProjectPaths {
  return {
    config: resolveProjectPath(projectRoot, overrides.config ?? ".roadrunner/config.json"),
    goals: resolveProjectPath(projectRoot, overrides.goals ?? overrides.goal ?? "GOALS.md"),
    lock: resolveProjectPath(projectRoot, overrides.lock ?? ".roadrunner/roadmap.lock"),
    logs: resolveProjectPath(projectRoot, overrides.logs ?? ".roadrunner/logs"),
    processRegistry: resolveProjectPath(projectRoot, overrides.processes ?? ".roadrunner/processes.json"),
    prompts: resolveProjectPath(projectRoot, overrides.prompts ?? ".roadrunner/prompts"),
    roadmap: resolveProjectPath(projectRoot, overrides.roadmap ?? "ROADMAP.md"),
  };
}

export async function loadContext(projectRoot = process.cwd(), overrides: LoadContextOverrides = {}): Promise<ProjectContext> {
  const configPath = overrides.config ? resolveProjectPath(projectRoot, overrides.config) : await defaultConfigPath(projectRoot);
  const fileConfig = (await pathExists(configPath)) ? await readConfig(configPath) : {};
  const configOverrides = { ...fileConfig.paths };
  const paths = projectPaths(projectRoot, { ...configOverrides, ...overrides, config: configPath });

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

  for (const [key, configValue] of Object.entries(value)) {
    const validator = configValidators[key as keyof typeof configValidators];
    if (!validator) {
      errors.push(`${filePath}.${key} is not a supported config key.`);
      continue;
    }
    errors.push(...validator(configValue, `${filePath}.${key}`));
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

function booleanValidator(value: unknown, pathLabel: string): string[] {
  return typeof value === "boolean" ? [] : [`${pathLabel} must be a boolean.`];
}

function nonEmptyStringValidator(value: unknown, pathLabel: string): string[] {
  return typeof value === "string" && value.length > 0 ? [] : [`${pathLabel} must be a non-empty string.`];
}

function nonNegativeIntegerValidator(value: unknown, pathLabel: string): string[] {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? [] : [`${pathLabel} must be a non-negative integer.`];
}

function pathsValidator(value: unknown, pathLabel: string): string[] {
  if (!isRecord(value)) return [`${pathLabel} must be a JSON object.`];

  const errors: string[] = [];
  for (const [key, pathValue] of Object.entries(value)) {
    const validator = pathValidators[key as keyof typeof pathValidators];
    if (!validator) {
      errors.push(`${pathLabel}.${key} is not a supported path key.`);
      continue;
    }
    errors.push(...validator(pathValue, `${pathLabel}.${key}`));
  }
  return errors;
}

function resolveProjectPath(projectRoot: string, filePath: string): string {
  return path.isAbsolute(filePath) ? filePath : path.resolve(projectRoot, filePath);
}

async function defaultConfigPath(projectRoot: string): Promise<string> {
  const rootConfig = resolveProjectPath(projectRoot, "roadrunner.config.json");
  if (await pathExists(rootConfig)) return rootConfig;
  return resolveProjectPath(projectRoot, ".roadrunner/config.json");
}
