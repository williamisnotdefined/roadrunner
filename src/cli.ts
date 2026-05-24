#!/usr/bin/env node

import { cleanupProcesses } from "./process-registry.js";
import { formatStep, nextStep, readQueue, validateGoals, validateQueueFile } from "./queue.js";
import { initProject } from "./init.js";
import { loadContext } from "./config.js";
import { numberOption, parseArgs } from "./args.js";
import { plan, run, status } from "./runner.js";

const args = parseArgs(process.argv.slice(2));
const command = args._[0] ?? "help";

try {
  const context = await loadContext(process.cwd(), args);

  if (command === "init") {
    await initProject(context);
    console.log("Roadrunner initialized.");
  } else if (command === "status") {
    const result = await status(context);
    console.log(`queued: ${result.queued}`);
    console.log(`done: ${result.done}`);
    console.log(`blocked: ${result.blocked}`);
    console.log("");
    console.log(formatStep(result.next));
  } else if (command === "next") {
    const queueFile = await readQueue(context);
    console.log(formatStep(nextStep(queueFile)));
  } else if (command === "check") {
    const queueFile = await readQueue(context);
    const errors = [...(await validateGoals(context)), ...validateQueueFile(queueFile)];
    if (errors.length > 0) throw new Error(errors.join("\n"));
    console.log("Roadrunner project is valid.");
  } else if (command === "plan") {
    const result = await plan(context);
    if (!result) console.log("No queued step.");
    else console.log(`Plan written to ${result.logDir}`);
  } else if (command === "run") {
    const completed = await run(context, { maxSteps: numberOption(args["max-steps"], 1) });
    console.log(`Completed ${completed} step(s).`);
  } else if (command === "cleanup") {
    const results = await cleanupProcesses(context, { force: Boolean(args.force) });
    if (results.length === 0) console.log("No Roadrunner-owned processes are registered.");
    for (const result of results) console.log(`${result.status}: pid=${result.pid} role=${result.role}`);
  } else {
    printHelp();
  }
} catch (error) {
  console.error((error as Error).message);
  process.exit(1);
}

function printHelp(): void {
  console.log(`Roadrunner

Commands:
  roadrunner init [--queue path] [--goals path]
  roadrunner check [--config path]
  roadrunner status [--config path]
  roadrunner next [--config path]
  roadrunner plan [--config path]
  roadrunner run [--config path] [--max-steps 1]
  roadrunner cleanup [--config path] [--force]

Path overrides:
  --goals path        Path to GOALS.md
  --goal path         Alias for --goals
  --queue path        Path to queue JSON
  --prompts dir       Prompt templates directory
  --logs dir          Logs directory
  --processes path    Process registry path
  --lock path         Lock path reserved for runners
`);
}
