import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

import { defaultModel, defaultVariant, projectPaths, readConfig } from "./config.mjs";
import { formatStep, markBlocked, markDone, nextStep, readExecution, validateExecution, validateGoals, writeExecution } from "./execution.mjs";
import { cleanupProcesses } from "./process-registry.mjs";
import { OpenCodeProvider } from "./providers/opencode.mjs";

export async function status(projectRoot = process.cwd()) {
  const execution = await readExecution(projectRoot);
  const errors = [...(await validateGoals(projectRoot)), ...validateExecution(execution)];
  if (errors.length > 0) throw new Error(errors.join("\n"));

  return {
    blocked: execution.blocked.length,
    done: execution.history.length,
    next: nextStep(execution),
    queued: execution.queue.length,
  };
}

export async function plan(projectRoot = process.cwd()) {
  const execution = await readExecution(projectRoot);
  const step = nextStep(execution);
  if (!step) return null;

  const logDir = await createLogDir(projectRoot, `${step.id}-plan`);
  const prompt = await renderPrompt(projectRoot, "plan-step.md", {
    GOALS_MD: await readFile(projectPaths(projectRoot).goals, "utf8"),
    ROADMAP_STATUS: formatStep(step),
    STEP_JSON: JSON.stringify(step, null, 2),
  });

  const provider = await providerFor(projectRoot);
  const result = await provider.run({
    agent: "plan",
    cwd: projectRoot,
    logPath: path.join(logDir, "plan.opencode.log"),
    prompt,
    role: "plan",
  });
  await writeFile(path.join(logDir, "plan.prompt.md"), prompt);
  await writeFile(path.join(logDir, "plan.md"), result.output);

  return { logDir, result, step };
}

export async function run(projectRoot = process.cwd(), { maxSteps = 1 } = {}) {
  await ensureCleanWorktree(projectRoot);
  let completed = 0;

  while (completed < maxSteps) {
    const execution = await readExecution(projectRoot);
    const step = nextStep(execution);
    if (!step) return completed;

    const planResult = await plan(projectRoot);
    if (!planResult || planResult.result.code !== 0) throw new Error(`Planning failed for ${step.id}.`);

    const logDir = await createLogDir(projectRoot, step.id);
    const prompt = await renderPrompt(projectRoot, "implement-step.md", {
      GOALS_MD: await readFile(projectPaths(projectRoot).goals, "utf8"),
      PLAN_MD: planResult.result.output,
      ROADMAP_STATUS: formatStep(step),
      STEP_JSON: JSON.stringify(step, null, 2),
    });
    await writeFile(path.join(logDir, "implement.prompt.md"), prompt);

    const provider = await providerFor(projectRoot);
    const result = await provider.run({
      agent: "build",
      cwd: projectRoot,
      logPath: path.join(logDir, "implement.opencode.log"),
      prompt,
      role: "implement",
    });

    if (result.code !== 0) {
      markBlocked(execution, step.id, `Provider exited ${result.code}`);
      await writeExecution(execution, projectRoot);
      throw new Error(`Implementation failed for ${step.id}.`);
    }

    const verification = await verify(projectRoot, step, logDir);
    if (!verification.ok) throw new Error(`Verification failed for ${step.id}.`);

    markDone(execution, step.id);
    await writeExecution(execution, projectRoot);
    completed += 1;
  }

  await cleanupProcesses(projectRoot);
  return completed;
}

export async function verify(projectRoot, step, logDir) {
  let output = "";

  for (const [index, command] of step.verification.entries()) {
    const result = await runShell(projectRoot, command, path.join(logDir, `verify-${index + 1}.log`));
    output += `$ ${command}\n${result.output}\n`;
    if (result.code !== 0) return { ok: false, output };
  }

  return { ok: true, output };
}

async function providerFor(projectRoot) {
  const config = await readConfig(projectRoot);
  if (config.provider !== "opencode") throw new Error(`Unsupported provider: ${config.provider}`);
  return new OpenCodeProvider({ model: config.model ?? defaultModel, variant: config.variant ?? defaultVariant });
}

async function renderPrompt(projectRoot, name, values) {
  const promptPath = path.join(projectPaths(projectRoot).prompts, name);
  let template = await readFile(promptPath, "utf8");
  for (const [key, value] of Object.entries(values)) template = template.replaceAll(`{{${key}}}`, value);
  return template;
}

async function createLogDir(projectRoot, name) {
  const timestamp = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
  const logDir = path.join(projectPaths(projectRoot).logs, `${timestamp}-${name}`);
  await mkdir(logDir, { recursive: true });
  return logDir;
}

async function runShell(projectRoot, command, logPath) {
  await mkdir(path.dirname(logPath), { recursive: true });
  const child = spawn(command, [], { cwd: projectRoot, shell: true });
  let output = "";
  child.stdout.on("data", (chunk) => {
    output += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    output += chunk.toString();
  });
  return new Promise((resolve) => {
    child.on("close", async (code) => {
      await writeFile(logPath, output);
      resolve({ code, output });
    });
  });
}

async function ensureCleanWorktree(projectRoot) {
  const result = await runShell(projectRoot, "git status --short", path.join(projectPaths(projectRoot).logs, "preflight-git-status.log"));
  if (result.output.trim() !== "") throw new Error("Roadrunner requires a clean git worktree.");
}
