import type { Dirent } from "node:fs";
import { open, readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

import type { ProjectContext } from "../infrastructure/config.js";

export interface TaskLogFile {
  active: boolean;
  label: string;
  path: string;
  relativePath: string;
  role: string;
  time: string | null;
}

const defaultTailBytes = 120_000;

export async function discoverTaskLogs(context: ProjectContext, taskId: string, activeLogPath?: string | null): Promise<TaskLogFile[]> {
  const logs: TaskLogFile[] = [];
  let entries: Dirent[] = [];
  try {
    entries = await readdir(context.paths.logs, { withFileTypes: true });
  } catch {
    entries = [];
  }

  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isDirectory() || !isTaskLogDir(entry.name, taskId)) continue;
    try {
      logs.push(...(await logsFromDirectory(context, entry.name, activeLogPath)));
    } catch {
      /* Log discovery is best-effort while the runner is writing files. */
    }
  }

  if (activeLogPath && !logs.some((log) => path.resolve(log.path) === path.resolve(activeLogPath))) {
    logs.push(logFile(context, activeLogPath, activeLogPath));
  }

  return logs.sort((left, right) => Number(right.active) - Number(left.active) || right.path.localeCompare(left.path));
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

async function logsFromDirectory(context: ProjectContext, entry: string, activeLogPath?: string | null): Promise<TaskLogFile[]> {
  const directory = path.join(context.paths.logs, entry);
  const files = await readdir(directory, { withFileTypes: true });
  return files
    .filter((file) => file.isFile() && file.name.endsWith(".log"))
    .map((file) => path.join(directory, file.name))
    .sort()
    .map((filePath) => logFile(context, filePath, activeLogPath));
}

function logFile(context: ProjectContext, filePath: string, activeLogPath?: string | null): TaskLogFile {
  const active = Boolean(activeLogPath && path.resolve(filePath) === path.resolve(activeLogPath));
  const role = logRole(filePath);
  const time = logTime(filePath);
  return {
    active,
    label: `${active ? "ACTIVE " : ""}${role}${time ? ` · ${time}` : ""}`,
    path: filePath,
    relativePath: relativeLogLabel(context, filePath),
    role,
    time,
  };
}

function logRole(filePath: string): string {
  const name = path.basename(filePath);
  const role = name.endsWith(".opencode.log") ? name.slice(0, -".opencode.log".length) : name.endsWith(".log") ? name.slice(0, -".log".length) : name;
  return role.replaceAll("-", " ");
}

function logTime(filePath: string): string | null {
  const directory = path.basename(path.dirname(filePath));
  const match = /T(\d{2})-(\d{2})-(\d{2})-\d{3}Z/.exec(directory);
  return match ? `${match[1]}:${match[2]}:${match[3]}` : null;
}
