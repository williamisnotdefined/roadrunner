#!/usr/bin/env node

import { realpathSync } from "node:fs";
import path from "node:path";
import type { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";

import chalk from "chalk";

import { cleanupProcesses } from "../infrastructure/process-registry.js";
import { formatStep, validateGoals } from "../domain/queue.js";
import { initProject } from "../application/init.js";
import { loadContext, type ProjectContext } from "../infrastructure/config.js";
import { integerOption, optionalNumberOption, parseArgs, pathOverridesFromArgs } from "./args.js";
import { shouldPrintHelp, validateCliInvocation } from "./validation.js";
import { plan, status, validateProvider, type RoadrunnerRunEvent } from "../application/runner.js";
import { formatDuration } from "../domain/duration.js";
import { runWithTui, type RunTuiOptions } from "../ui/run-tui.js";

export interface CliIo {
  stderr?: (message: string) => void;
  stdout?: (message: string) => void;
}

export interface CliMainOptions {
  cwd?: string;
  io?: CliIo;
  platform?: NodeJS.Platform;
  runTui?: (context: ProjectContext, options: RunTuiOptions) => Promise<number>;
  terminal?: {
    input?: Readable;
    isInteractive?: boolean;
    output?: Writable;
  };
}

interface CliCommandInput {
  args: ReturnType<typeof parseArgs>;
  context: ProjectContext;
  out: (message: string) => void;
  runTui?: (context: ProjectContext, options: RunTuiOptions) => Promise<number>;
  terminal?: CliMainOptions["terminal"];
}

type CliCommandHandler = (input: CliCommandInput) => Promise<void>;

const commandHandlers = {
  async check({ context, out }) {
    out(formatCliStep("Validating Roadrunner project"));
    const errors = await validateGoals(context);
    if (errors.length === 0) errors.push(...(await validateProvider(context)));
    if (errors.length > 0) throw new Error(errors.join("\n"));
    out(formatCliSuccess("Roadrunner project is valid."));
  },
  async cleanup({ args, context, out }) {
    out(formatCliStep("Cleaning Roadrunner-owned processes"));
    const results = await cleanupProcesses(context, { force: Boolean(args.force) });
    if (results.length === 0) out(formatCliInfo("No Roadrunner-owned processes are registered."));
    for (const result of results) out(`${result.status}: pid=${result.pid} role=${result.role}`);
  },
  async init({ context, out }) {
    out(formatCliStep("Initializing Roadrunner project"));
    await initProject(context);
    out(formatCliSuccess("Roadrunner initialized."));
  },
  async next({ context, out }) {
    out(formatCliStep("Reading next queued step"));
    out(formatStep((await status(context)).next));
  },
  async plan({ context, out }) {
    out(formatCliStep("Planning next queued step"));
    const result = await plan(context, { onProviderStart: (event) => out(formatProviderStartEvent(event)) });
    if (!result) out(formatCliInfo("No queued step."));
    else if (result.result.code !== 0)
      throw new Error(`Planning failed for ${result.step.id} (exit ${String(result.result.code)}). See ${path.join(result.logDir, "plan.opencode.log")}.`);
    else out(formatCliSuccess(`Plan written to ${result.logDir}`));
  },
  async run({ args, context, runTui, terminal }) {
    await (runTui ?? runWithTui)(context, {
      input: terminal?.input,
      isInteractive: terminal?.isInteractive,
      maxHours: optionalNumberOption(args["max-hours"]),
      maxSteps: integerOption(args["max-steps"], 1),
      output: terminal?.output,
    });
  },
  async status({ context, out }) {
    out(formatCliStep("Reading Roadrunner status"));
    const result = await status(context);
    out(`${chalk.cyan("queued:")} ${result.queued}`);
    out(`${chalk.cyan("done:")} ${result.done}`);
    out(`${chalk.cyan("blocked:")} ${result.blocked}`);
    out("");
    out(formatStep(result.next));
  },
} satisfies Record<string, CliCommandHandler>;

type RunEventFormatter<T extends RoadrunnerRunEvent["type"]> = (event: Extract<RoadrunnerRunEvent, { type: T }>) => string;

const runEventFormatters: { [Type in RoadrunnerRunEvent["type"]]: RunEventFormatter<Type> } = {
  cleanup: () => formatCliStep("Cleaning Roadrunner-owned processes"),
  fix: (event) => formatCliStep(`Fixing verification failure for ${event.step.id}`),
  implement: (event) => formatCliStep(`Implementing ${event.step.id}`),
  plan: (event) => formatCliStep(`Planning ${event.step.id}`),
  "provider-start": formatProviderStartEvent,
  "queue-updated": (event) => formatCliInfo(`Queue updated: queued=${event.queueFile.queue.length} done=${event.queueFile.history.length} blocked=${event.queueFile.blocked.length}`),
  reconcile: (event) => formatCliStep(`Reconciling and optimizing queue after ${event.step.id}`),
  "run-stop-requested": () => formatCliInfo("Stop requested; cleaning Roadrunner-owned processes"),
  step: (event) => formatCliStep(`Selected step ${event.step.id}: ${event.step.title}`),
  "step-complete": (event) => formatCliSuccess(`Completed ${event.step.id}`),
  "startup-refresh": () => formatCliStep("Refreshing queue from roadmap and repository state"),
  "task-auto-restart-limit-exceeded": (event) => {
    const phase = event.phase ? ` during ${event.phase}` : "";
    return formatCliError(`Auto-restart limit exceeded for ${event.step.id}${phase} after idle=${formatDuration(event.idleMs)} max=${event.maxRestarts}`);
  },
  "task-auto-restart-requested": (event) => {
    const phase = event.phase ? ` during ${event.phase}` : "";
    return formatCliInfo(`Auto-restart requested for ${event.step.id}${phase} after idle=${formatDuration(event.idleMs)} restart=${event.restart}/${event.maxRestarts}`);
  },
  "task-restart": (event) => formatCliStep(`Restarting ${event.step.id} attempt=${event.attempt}`),
  "task-restart-requested": (event) => {
    const phase = event.phase ? ` during ${event.phase}` : "";
    return formatCliInfo(`Restart requested for ${event.step.id}${phase} after ${formatDuration(event.elapsedMs)}`);
  },
  validate: () => formatCliStep("Validating project"),
  verify: (event) => formatCliStep(event.attempt === "fixed" ? `Re-running verification for ${event.step.id}` : `Verifying ${event.step.id}`),
};

export async function main(argv = process.argv.slice(2), { cwd = process.cwd(), io = {}, platform = process.platform, runTui, terminal }: CliMainOptions = {}): Promise<number> {
  const out = io.stdout ?? ((message: string) => console.log(message));
  const err = io.stderr ?? ((message: string) => console.error(message));
  const args = parseArgs(argv);
  const command = args._[0] ?? "help";

  try {
    assertLinuxPlatform(platform);

    if (shouldPrintHelp(args, command)) {
      out(helpText());
      return 0;
    }

    const invocationErrors = validateCliInvocation(command, args);
    if (invocationErrors.length > 0) throw new Error(invocationErrors.join("\n"));

    const context = await loadContext(cwd, pathOverridesFromArgs(args));

    const handler = commandHandlers[command as keyof typeof commandHandlers];
    if (!handler) throw new Error(`Unknown command: ${command}.`);
    await handler({ args, context, out, runTui, terminal });

    return 0;
  } catch (error) {
    err(formatCliError((error as Error).message));
    return 1;
  }
}

export function formatRunEvent(event: RoadrunnerRunEvent): string {
  return (runEventFormatters[event.type] as (nextEvent: RoadrunnerRunEvent) => string)(event);
}

function assertLinuxPlatform(platform: NodeJS.Platform): void {
  if (platform !== "linux") throw new Error("Roadrunner supports Linux only.");
}

function formatProviderStartEvent(event: { debug: boolean; logPath: string; pid: number | null; role: string }): string {
  const debug = event.debug ? " debug=on" : "";
  return formatCliStep(`OpenCode ${event.role} started pid=${event.pid ?? "n/a"} log=${event.logPath}${debug}`);
}

function formatCliStep(message: string): string {
  return `${chalk.cyan("[step]")} ${chalk.bold(message)}`;
}

function formatCliSuccess(message: string): string {
  return `${chalk.green("[ok]")} ${message}`;
}

function formatCliInfo(message: string): string {
  return `${chalk.blue("[info]")} ${message}`;
}

function formatCliError(message: string): string {
  return `${chalk.red("[error]")} ${message}`;
}

export function helpText(): string {
  return `Roadrunner

Commands:
  roadrunner init [--goals path] [--roadmap path]
  roadrunner check [--config path]
  roadrunner status [--config path]
  roadrunner next [--config path]
  roadrunner plan [--config path]
  roadrunner run [--config path] [--max-steps 1] [--max-hours n]
  roadrunner cleanup [--config path] [--force]

  Run UI controls:
  Up/Down            Select tasks or logs
  Tab/Shift+Tab      Switch between task, logs, and log viewer panels
  Enter              Open the selected task log
  Enter/Esc          Close an active failure modal
  r                  Restart the current task attempt from planning
  q, Ctrl+C, Ctrl+Q  Stop the run and clean Roadrunner-owned subprocesses

Path overrides:
  --goals path        Path to GOALS.md
  --goal path         Alias for --goals
  --roadmap path      Path to roadmap Markdown
  --prompts dir       Prompt templates directory
  --logs dir          Logs directory
  --processes path    Process registry path
  --lock path         Lock path reserved for runners
`;
}

export function isCliEntrypoint(importMetaUrl: string, argvPath = process.argv[1]): boolean {
  if (!argvPath) return false;

  const modulePath = fileURLToPath(importMetaUrl);
  const invokedPath = path.resolve(argvPath);

  return realPathOrSelf(modulePath) === realPathOrSelf(invokedPath);
}

function realPathOrSelf(filePath: string): string {
  try {
    return realpathSync(filePath);
  } catch {
    return filePath;
  }
}

/* v8 ignore next -- the package bin entrypoint is outside in-process unit coverage. */
const isEntrypoint = isCliEntrypoint(import.meta.url);
/* v8 ignore next 3 -- the package bin entrypoint is outside in-process unit coverage. */
if (isEntrypoint) {
  process.exitCode = await main();
}
