export type CliArgs = Record<string, string | boolean | string[]> & { _: string[] };

export function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { _: [] };

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index] ?? "";

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
