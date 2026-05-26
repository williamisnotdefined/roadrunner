import { constants, type WriteStream } from "node:fs";
import { chmod, mkdir, open, readFile } from "node:fs/promises";
import path from "node:path";

import { packageRoot, pathExists, type ProjectContext } from "./config.js";

let logDirCounter = 0;

export async function renderPrompt(context: ProjectContext, name: string, values: Record<string, string>): Promise<string> {
  const promptPath = await promptTemplatePath(context, name);
  let template = await readFile(promptPath, "utf8");
  for (const [key, value] of Object.entries(values)) template = template.replaceAll(`{{${key}}}`, value);
  return template;
}

async function promptTemplatePath(context: ProjectContext, name: string): Promise<string> {
  const projectPromptPath = path.join(context.paths.prompts, name);
  if (await pathExists(projectPromptPath)) return projectPromptPath;
  return path.join(packageRoot, "templates", "prompts", name);
}

export async function createLogDir(context: ProjectContext, name: string): Promise<string> {
  const timestamp = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
  logDirCounter = (logDirCounter + 1) % Number.MAX_SAFE_INTEGER;
  const logDir = path.join(context.paths.logs, `${timestamp}-r${process.pid}-${logDirCounter}-${name}`);
  await mkdir(context.paths.logs, { mode: 0o700, recursive: true });
  await mkdir(logDir, { mode: 0o700 });
  await chmod(logDir, 0o700);
  return logDir;
}

export async function writePrivateFile(filePath: string, content: string): Promise<void> {
  const handle = await openPrivateFile(filePath);
  try {
    await handle.writeFile(content);
  } finally {
    await handle.close();
  }
}

export async function createPrivateWriteStream(filePath: string): Promise<WriteStream> {
  const handle = await openPrivateFile(filePath);
  return handle.createWriteStream({ autoClose: true });
}

async function openPrivateFile(filePath: string) {
  const handle = await open(filePath, constants.O_CREAT | constants.O_TRUNC | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  await handle.chmod(0o600);
  return handle;
}
