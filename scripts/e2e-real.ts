#!/usr/bin/env tsx

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import chalk from "chalk";

const execFileAsync = promisify(execFile);

try {
  logStep("Checking OpenCode availability");
  const version = await openCodeVersion();
  logOk(`OpenCode available: ${version}`);

  logStep("Enabling explicit real-provider e2e opt-in");
  process.env.ROADRUNNER_E2E_REAL_OPENCODE = "1";
  process.env.ROADRUNNER_PROVIDER_TIMEOUT_MS ??= "300000";
  logOk(`OpenCode debug logs: ${process.env.ROADRUNNER_OPENCODE_DEBUG === "1" ? "on" : "off"}`);
  logOk(`Provider timeout: ${process.env.ROADRUNNER_PROVIDER_TIMEOUT_MS} ms`);

  logStep("Running real Todo CRUD e2e");
  await import("../tests/e2e-real/todo-crud.real-e2e.js");

  logOk("Real provider e2e passed");
} catch (error) {
  console.error(formatError((error as Error).message));
  process.exitCode = 1;
}

async function openCodeVersion(): Promise<string> {
  try {
    const result = await execFileAsync("opencode", ["--version"]);
    return result.stdout.trim() || "version output empty";
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") throw new Error("opencode was not found in PATH.");
    throw error;
  }
}

function logStep(message: string): void {
  console.log(`${chalk.cyan("[step]")} ${chalk.bold(message)}`);
}

function logOk(message: string): void {
  console.log(`${chalk.green("[ok]")} ${message}`);
}

function formatError(message: string): string {
  return `${chalk.red("[error]")} ${message}`;
}
