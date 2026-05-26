export function parseNonNegativeIntegerValue(name: string, value: string | undefined, defaultValue: number): number {
  if (value === undefined) return defaultValue;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`${name} must be a non-negative integer, got ${value}.`);
  return parsed;
}
