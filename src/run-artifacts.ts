import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type { ProjectContext } from "./config.js";

export async function renderPrompt(context: ProjectContext, name: string, values: Record<string, string>): Promise<string> {
  const promptPath = path.join(context.paths.prompts, name);
  let template = await readFile(promptPath, "utf8");
  for (const [key, value] of Object.entries(values)) template = template.replaceAll(`{{${key}}}`, value);
  return template;
}

export async function createLogDir(context: ProjectContext, name: string): Promise<string> {
  const timestamp = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
  const logDir = path.join(context.paths.logs, `${timestamp}-${name}`);
  await mkdir(logDir, { mode: 0o700, recursive: true });
  await chmod(logDir, 0o700);
  return logDir;
}

export async function writePrivateFile(filePath: string, content: string): Promise<void> {
  await writeFile(filePath, content, { mode: 0o600 });
  await chmod(filePath, 0o600);
}
