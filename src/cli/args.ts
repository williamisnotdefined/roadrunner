import type { PathOverrides } from "../infrastructure/config.js";

export type CliArgs = Record<string, string | boolean | string[]> & { _: string[] };

export function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { _: [] };

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]!;

    if (!value.startsWith("--")) {
      args._.push(value);
      continue;
    }

    const [key, inlineValue] = value.slice(2).split("=", 2);
    if (!key) continue;

    if (inlineValue !== undefined) {
      args[key] = inlineValue;
      continue;
    }

    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith("--")) {
      args[key] = next;
      index += 1;
      continue;
    }

    args[key] = true;
  }

  return args;
}

export function stringOption(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function numberOption(value: unknown, defaultValue: number): number {
  if (value === undefined || value === true) return defaultValue;

  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    throw new Error(`Expected a positive number, got ${String(value)}.`);
  }

  return number;
}

export function integerOption(value: unknown, defaultValue: number): number {
  const number = numberOption(value, defaultValue);
  if (!Number.isSafeInteger(number)) throw new Error(`Expected a positive integer, got ${String(value)}.`);
  return number;
}

export function optionalNumberOption(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (value === true) throw new Error("Expected a positive number, got true.");
  return numberOption(value, 0);
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
    ["roadmap", args.roadmap],
  ];

  for (const [key, value] of options) {
    const option = stringOption(value);
    if (option !== undefined) overrides[key] = option;
  }

  return overrides;
}
