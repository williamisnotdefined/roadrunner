#!/usr/bin/env node

import { cleanupProcesses } from "./process-registry.mjs";
import { formatStep, nextStep, readExecution, validateExecution, validateGoals } from "./execution.mjs";
import { initProject } from "./init.mjs";
import { numberOption, parseArgs } from "./args.mjs";
import { plan, run, status } from "./runner.mjs";

const args = parseArgs(process.argv.slice(2));
const command = args._[0] ?? "help";

try {
  if (command === "init") {
    await initProject(process.cwd());
    console.log("Roadrunner initialized.");
  } else if (command === "status") {
    const result = await status(process.cwd());
    console.log(`queued: ${result.queued}`);
    console.log(`done: ${result.done}`);
    console.log(`blocked: ${result.blocked}`);
    console.log("");
    console.log(formatStep(result.next));
  } else if (command === "next") {
    const execution = await readExecution(process.cwd());
    console.log(formatStep(nextStep(execution)));
  } else if (command === "check") {
    const execution = await readExecution(process.cwd());
    const errors = [...(await validateGoals(process.cwd())), ...validateExecution(execution)];
    if (errors.length > 0) throw new Error(errors.join("\n"));
    console.log("Roadrunner project is valid.");
  } else if (command === "plan") {
    const result = await plan(process.cwd());
    if (!result) console.log("No queued step.");
    else console.log(`Plan written to ${result.logDir}`);
  } else if (command === "run") {
    const completed = await run(process.cwd(), { maxSteps: numberOption(args["max-steps"], 1) });
    console.log(`Completed ${completed} step(s).`);
  } else if (command === "cleanup") {
    const results = await cleanupProcesses(process.cwd(), { force: Boolean(args.force) });
    if (results.length === 0) console.log("No Roadrunner-owned processes are registered.");
    for (const result of results) console.log(`${result.status}: pid=${result.pid} role=${result.role}`);
  } else {
    printHelp();
  }
} catch (error) {
  console.error(error.message);
  process.exit(1);
}

function printHelp() {
  console.log(`Roadrunner

Commands:
  roadrunner init
  roadrunner check
  roadrunner status
  roadrunner next
  roadrunner plan
  roadrunner run --max-steps 1
  roadrunner cleanup [--force]
`);
}
