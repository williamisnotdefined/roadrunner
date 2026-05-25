import { open, readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

import type { ProjectContext } from "./config.js";

export interface TaskLogFile {
  label: string;
  path: string;
}

const defaultTailBytes = 120_000;

export async function discoverTaskLogs(context: ProjectContext, taskId: string, activeLogPath?: string | null): Promise<TaskLogFile[]> {
  const logs: TaskLogFile[] = [];
  let entries: string[] = [];
  try {
    entries = await readdir(context.paths.logs);
  } catch {
    entries = [];
  }

  for (const entry of entries.sort()) {
    if (!isTaskLogDir(entry, taskId)) continue;
    logs.push(...(await logsFromDirectory(context, entry)));
  }

  if (activeLogPath && !logs.some((log) => path.resolve(log.path) === path.resolve(activeLogPath))) {
    logs.push({ label: relativeLogLabel(context, activeLogPath), path: activeLogPath });
  }

  return logs;
}

export async function readLogTail(filePath: string, maxBytes = defaultTailBytes): Promise<string> {
  const fileStat = await stat(filePath);
  if (fileStat.size <= maxBytes) return readFile(filePath, "utf8");

  const handle = await open(filePath, "r");
  try {
    const buffer = Buffer.alloc(maxBytes);
    await handle.read(buffer, 0, maxBytes, fileStat.size - maxBytes);
    return `[Showing last ${maxBytes} bytes of ${fileStat.size}]\n${buffer.toString("utf8")}`;
  } finally {
    await handle.close();
  }
}

export function relativeLogLabel(context: ProjectContext, filePath: string): string {
  const relative = path.relative(context.paths.logs, filePath).split(path.sep).join(path.posix.sep);
  return relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative) ? relative : filePath;
}

function isTaskLogDir(entry: string, taskId: string): boolean {
  return entry.endsWith(`-${taskId}`) || entry.endsWith(`-${taskId}-plan`);
}

async function logsFromDirectory(context: ProjectContext, entry: string): Promise<TaskLogFile[]> {
  const directory = path.join(context.paths.logs, entry);
  const files = await readdir(directory, { withFileTypes: true });
  return files
    .filter((file) => file.isFile())
    .map((file) => path.join(directory, file.name))
    .sort()
    .map((filePath) => ({ label: relativeLogLabel(context, filePath), path: filePath }));
}
