import type { CliArgs } from "./args.js";

export const projectCommands = new Set(["check", "cleanup", "init", "next", "plan", "run", "status"]);

const pathOptions = ["config", "goals", "goal", "lock", "logs", "processes", "prompts", "roadmap"];
const commandOptions: Record<string, string[]> = {
  check: [],
  cleanup: ["force"],
  init: [],
  next: [],
  plan: [],
  run: ["max-hours", "max-steps"],
  status: [],
};
const valueOptions = new Set([...pathOptions, "max-hours", "max-steps"]);
const booleanOptions = new Set(["force", "help"]);

export function shouldPrintHelp(args: CliArgs, command: string): boolean {
  return command === "help" || args.help === true;
}

export function validateCliInvocation(command: string, args: CliArgs): string[] {
  const errors: string[] = [];
  if (!projectCommands.has(command)) return [`Unknown command: ${command}.`];
  if (args._.length > 1) errors.push(`Unexpected positional argument: ${args._[1]}.`);

  const allowedOptions = new Set([...pathOptions, ...(commandOptions[command] ?? []), "help"]);
  for (const [key, value] of Object.entries(args)) {
    if (key === "_") continue;
    if (!allowedOptions.has(key)) {
      errors.push(`Unsupported option for ${command}: --${key}.`);
      continue;
    }
    if (valueOptions.has(key) && (typeof value !== "string" || value.length === 0)) errors.push(`Expected a value for --${key}.`);
    if (booleanOptions.has(key) && typeof value !== "boolean") errors.push(`Option --${key} does not take a value.`);
  }

  return errors;
}
