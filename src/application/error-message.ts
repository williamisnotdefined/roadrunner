export function formatContextualError(title: string, details: readonly string[] = [], logPath?: string): string {
  const lines = [title];

  if (details.length > 0) {
    lines.push("", "Details:", details.join("\n"));
  }

  if (logPath) {
    lines.push("", "Log:", logPath);
  }

  return lines.join("\n");
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
