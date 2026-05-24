#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath } from "node:url";

import { cleanupProcesses } from "./process-registry.js";
import { formatStep, nextStep, readQueue, validateGoals, validateQueueFile } from "./queue.js";
import { initProject } from "./init.js";
import { loadContext } from "./config.js";
import { numberOption, optionalNumberOption, parseArgs } from "./args.js";
import { plan, run, status } from "./runner.js";
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
      await initProject(context);
      out("Roadrunner initialized.");
    } else if (command === "status") {
      const result = await status(context);
      out(`queued: ${result.queued}`);
      out(`done: ${result.done}`);
      out(`blocked: ${result.blocked}`);
      out("");
      out(formatStep(result.next));
    } else if (command === "next") {
      const queueFile = await readQueue(context);
      out(formatStep(nextStep(queueFile)));
    } else if (command === "check") {
      const queueFile = await readQueue(context);
      const errors = [...(await validateGoals(context)), ...validateQueueFile(queueFile)];
      if (errors.length > 0) throw new Error(errors.join("\n"));
      out("Roadrunner project is valid.");
    } else if (command === "import-roadmap") {
      const queueFile = await importRoadmap(context);
      out(`Imported roadmap from ${context.paths.roadmap}.`);
      out(`queued: ${queueFile.queue.length}`);
      out(`done: ${queueFile.history.length}`);
      out(`blocked: ${queueFile.blocked.length}`);
    } else if (command === "plan") {
      const result = await plan(context);
      if (!result) out("No queued step.");
      else out(`Plan written to ${result.logDir}`);
    } else if (command === "run") {
      const completed = await run(context, { maxHours: optionalNumberOption(args["max-hours"]), maxSteps: numberOption(args["max-steps"], 1) });
      out(`Completed ${completed} step(s).`);
    } else if (command === "cleanup") {
      const results = await cleanupProcesses(context, { force: Boolean(args.force) });
      if (results.length === 0) out("No Roadrunner-owned processes are registered.");
      for (const result of results) out(`${result.status}: pid=${result.pid} role=${result.role}`);
    } else {
      out(helpText());
    }

    return 0;
  } catch (error) {
    err((error as Error).message);
    return 1;
  }
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
