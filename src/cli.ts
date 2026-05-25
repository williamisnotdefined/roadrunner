#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath } from "node:url";

import chalk from "chalk";

import { cleanupProcesses } from "./process-registry.js";
import { formatStep, nextStep, readQueue, validateGoals, validateQueueFile } from "./queue.js";
import { initProject } from "./init.js";
import { loadContext } from "./config.js";
import { numberOption, optionalNumberOption, parseArgs } from "./args.js";
import { plan, run, status, type RoadrunnerRunEvent } from "./runner.js";
import { importRoadmap } from "./roadmap.js";

export interface CliIo {
  stderr?: (message: string) => void;
  stdout?: (message: string) => void;
}

export interface CliMainOptions {
  cwd?: string;
  io?: CliIo;
}

export async function main(argv = process.argv.slice(2), { cwd = process.cwd(), io = {} }: CliMainOptions = {}): Promise<number> {
  const out = io.stdout ?? ((message: string) => console.log(message));
  const err = io.stderr ?? ((message: string) => console.error(message));
  const args = parseArgs(argv);
  const command = args._[0] ?? "help";

  try {
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
      out(formatStep(nextStep(queueFile)));
    } else if (command === "check") {
      out(formatCliStep("Validating Roadrunner project"));
      const queueFile = await readQueue(context);
      const errors = [...(await validateGoals(context)), ...validateQueueFile(queueFile, { model: context.config.model, variant: context.config.variant })];
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
      else if (result.result.code !== 0) throw new Error(`Planning failed for ${result.step.id} (exit ${String(result.result.code)}). See ${path.join(result.logDir, "plan.opencode.log")}.`);
      else out(formatCliSuccess(`Plan written to ${result.logDir}`));
    } else if (command === "run") {
      out(formatCliStep("Running Roadrunner"));
      const completed = await run(context, {
        maxHours: optionalNumberOption(args["max-hours"]),
        maxSteps: numberOption(args["max-steps"], 1),
        onEvent: (event) => out(formatRunEvent(event)),
      });
      out(formatCliSuccess(`Completed ${completed} step(s).`));
    } else if (command === "cleanup") {
      out(formatCliStep("Cleaning Roadrunner-owned processes"));
      const results = await cleanupProcesses(context, { force: Boolean(args.force) });
      if (results.length === 0) out(formatCliInfo("No Roadrunner-owned processes are registered."));
      for (const result of results) out(`${result.status}: pid=${result.pid} role=${result.role}`);
    } else {
      out(helpText());
    }

    return 0;
  } catch (error) {
    err(formatCliError((error as Error).message));
    return 1;
  }
}

export function formatRunEvent(event: RoadrunnerRunEvent): string {
  switch (event.type) {
    case "clean-worktree":
      return formatCliStep("Checking clean git worktree");
    case "cleanup":
      return formatCliStep("Cleaning Roadrunner-owned processes");
    case "commit":
      return formatCliStep(`Committing ${event.step.id}`);
    case "fix":
      return formatCliStep(`Fixing verification failure for ${event.step.id}`);
    case "implement":
      return formatCliStep(`Implementing ${event.step.id}`);
    case "plan":
      return formatCliStep(`Planning ${event.step.id}`);
    case "provider-start":
      return formatProviderStartEvent(event);
    case "reconcile":
      return formatCliStep(`Reconciling queue after ${event.step.id}`);
    case "step":
      return formatCliStep(`Selected step ${event.step.id}: ${event.step.title}`);
    case "step-complete":
      return formatCliSuccess(`Completed ${event.step.id}`);
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

/* v8 ignore next -- the package bin entrypoint is outside in-process unit coverage. */
const isEntrypoint = process.argv[1] ? fileURLToPath(import.meta.url) === path.resolve(process.argv[1]) : false;
/* v8 ignore next 3 -- the package bin entrypoint is outside in-process unit coverage. */
if (isEntrypoint) {
  process.exitCode = await main();
}
