#!/usr/bin/env node

import { realpathSync } from "node:fs";
import path from "node:path";
import type { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";

import chalk from "chalk";

import { cleanupProcesses } from "../infrastructure/process-registry.js";
import { formatStep, nextStep, normalizeQueueFile, readQueue, validateGoals, validateQueueFile } from "../domain/queue.js";
import { initProject } from "../application/init.js";
import { loadContext, type ProjectContext } from "../infrastructure/config.js";
import { integerOption, optionalNumberOption, parseArgs } from "./args.js";
import { shouldPrintHelp, validateCliInvocation } from "./validation.js";
import { plan, status, validateProvider, type RoadrunnerRunEvent } from "../application/runner.js";
import { importRoadmap } from "../domain/roadmap.js";
import { formatDuration } from "../domain/duration.js";
import { runWithTui, type RunTuiOptions } from "../ui/run-tui.js";

export interface CliIo {
  stderr?: (message: string) => void;
  stdout?: (message: string) => void;
}

export interface CliMainOptions {
  cwd?: string;
  io?: CliIo;
  runTui?: (context: ProjectContext, options: RunTuiOptions) => Promise<number>;
  terminal?: {
    input?: Readable;
    isInteractive?: boolean;
    output?: Writable;
  };
}

export async function main(argv = process.argv.slice(2), { cwd = process.cwd(), io = {}, runTui, terminal }: CliMainOptions = {}): Promise<number> {
  const out = io.stdout ?? ((message: string) => console.log(message));
  const err = io.stderr ?? ((message: string) => console.error(message));
  const args = parseArgs(argv);
  const command = args._[0] ?? "help";

  try {
    if (shouldPrintHelp(args, command)) {
      out(helpText());
      return 0;
    }

    const invocationErrors = validateCliInvocation(command, args);
    if (invocationErrors.length > 0) throw new Error(invocationErrors.join("\n"));

    const context = await loadContext(cwd, args);

    if (command === "init") {
      out(formatCliStep("Initializing Roadrunner project"));
      await initProject(context);
      out(formatCliSuccess("Roadrunner initialized."));
    } else if (command === "status") {
      out(formatCliStep("Reading Roadrunner status"));
      const result = await status(context);
      out(`${chalk.cyan("queued:")} ${result.queued}`);
      out(`${chalk.cyan("done:")} ${result.done}`);
      out(`${chalk.cyan("blocked:")} ${result.blocked}`);
      out("");
      out(formatStep(result.next));
    } else if (command === "next") {
      out(formatCliStep("Reading next queued step"));
      const queueFile = await readQueue(context);
      const errors = validateQueueFile(queueFile, { model: context.config.model, variant: context.config.variant });
      if (errors.length > 0) throw new Error(errors.join("\n"));
      out(formatStep(nextStep(normalizeQueueFile(queueFile))));
    } else if (command === "check") {
      out(formatCliStep("Validating Roadrunner project"));
      const queueFile = await readQueue(context);
      const errors = [...(await validateGoals(context)), ...validateQueueFile(queueFile, { model: context.config.model, variant: context.config.variant })];
      if (errors.length === 0) errors.push(...(await validateProvider(context)));
      if (errors.length > 0) throw new Error(errors.join("\n"));
      out(formatCliSuccess("Roadrunner project is valid."));
    } else if (command === "import-roadmap") {
      out(formatCliStep(`Importing roadmap from ${context.paths.roadmap}`));
      const queueFile = await importRoadmap(context);
      out(formatCliSuccess(`Imported roadmap from ${context.paths.roadmap}.`));
      out(`queued: ${queueFile.queue.length}`);
      out(`done: ${queueFile.history.length}`);
      out(`blocked: ${queueFile.blocked.length}`);
    } else if (command === "plan") {
      out(formatCliStep("Planning next queued step"));
      const result = await plan(context, { onProviderStart: (event) => out(formatProviderStartEvent(event)) });
      if (!result) out(formatCliInfo("No queued step."));
      else if (result.result.code !== 0)
        throw new Error(`Planning failed for ${result.step.id} (exit ${String(result.result.code)}). See ${path.join(result.logDir, "plan.opencode.log")}.`);
      else out(formatCliSuccess(`Plan written to ${result.logDir}`));
    } else if (command === "run") {
      await (runTui ?? runWithTui)(context, {
        input: terminal?.input,
        isInteractive: terminal?.isInteractive,
        maxHours: optionalNumberOption(args["max-hours"]),
        maxSteps: integerOption(args["max-steps"], 1),
        output: terminal?.output,
      });
    } else {
      out(formatCliStep("Cleaning Roadrunner-owned processes"));
      const results = await cleanupProcesses(context, { force: Boolean(args.force) });
      if (results.length === 0) out(formatCliInfo("No Roadrunner-owned processes are registered."));
      for (const result of results) out(`${result.status}: pid=${result.pid} role=${result.role}`);
    }

    return 0;
  } catch (error) {
    err(formatCliError((error as Error).message));
    return 1;
  }
}

export function formatRunEvent(event: RoadrunnerRunEvent): string {
  switch (event.type) {
    case "cleanup":
      return formatCliStep("Cleaning Roadrunner-owned processes");
    case "fix":
      return formatCliStep(`Fixing verification failure for ${event.step.id}`);
    case "implement":
      return formatCliStep(`Implementing ${event.step.id}`);
    case "plan":
      return formatCliStep(`Planning ${event.step.id}`);
    case "provider-start":
      return formatProviderStartEvent(event);
    case "reconcile":
      return formatCliStep(`Reconciling and optimizing queue after ${event.step.id}`);
    case "run-stop-requested":
      return formatCliInfo("Stop requested; cleaning Roadrunner-owned processes");
    case "step":
      return formatCliStep(`Selected step ${event.step.id}: ${event.step.title}`);
    case "step-complete":
      return formatCliSuccess(`Completed ${event.step.id}`);
    case "startup-refresh":
      return formatCliStep("Refreshed queue from roadmap and repository state");
    case "task-auto-restart-limit-exceeded": {
      const phase = event.phase ? ` during ${event.phase}` : "";
      return formatCliError(`Auto-restart limit exceeded for ${event.step.id}${phase} after idle=${formatDuration(event.idleMs)} max=${event.maxRestarts}`);
    }
    case "task-auto-restart-requested": {
      const phase = event.phase ? ` during ${event.phase}` : "";
      return formatCliInfo(`Auto-restart requested for ${event.step.id}${phase} after idle=${formatDuration(event.idleMs)} restart=${event.restart}/${event.maxRestarts}`);
    }
    case "task-restart":
      return formatCliStep(`Restarting ${event.step.id} attempt=${event.attempt}`);
    case "task-restart-requested": {
      const phase = event.phase ? ` during ${event.phase}` : "";
      return formatCliInfo(`Restart requested for ${event.step.id}${phase} after ${formatDuration(event.elapsedMs)}`);
    }
    case "validate":
      return formatCliStep("Validating project");
    case "verify":
      return formatCliStep(event.attempt === "fixed" ? `Re-running verification for ${event.step.id}` : `Verifying ${event.step.id}`);
  }
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
  roadrunner init [--queue path] [--goals path] [--roadmap path]
  roadrunner check [--config path]
  roadrunner status [--config path]
  roadrunner next [--config path]
  roadrunner import-roadmap [--roadmap path] [--queue path]
  roadrunner plan [--config path]
  roadrunner run [--config path] [--max-steps 1] [--max-hours n]
  roadrunner cleanup [--config path] [--force]

Run UI controls:
  Up/Down            Select tasks or logs
  Tab/Shift+Tab      Switch between task, logs, and log viewer panels
  Enter              Open the selected task log
  r                  Restart the current task attempt from planning
  q, Ctrl+C, Ctrl+Q  Stop the run and clean Roadrunner-owned subprocesses

Path overrides:
  --goals path        Path to GOALS.md
  --goal path         Alias for --goals
  --queue path        Path to queue JSON
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
