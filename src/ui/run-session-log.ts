import { appendFile } from "node:fs/promises";
import path from "node:path";

import type { ProjectContext } from "../infrastructure/config.js";
import { createLogDir, writePrivateFile } from "../infrastructure/run-artifacts.js";

export interface RunSessionLogger {
  eventsLogPath: string;
  logDir: string;
  sessionLogPath: string;
  close(): Promise<void>;
  event(type: string, message: string, payload?: Record<string, unknown>): void;
}

export async function createRunSessionLogger(context: ProjectContext, clock = () => new Date()): Promise<RunSessionLogger> {
  const logDir = await createLogDir(context, "run");
  const sessionLogPath = path.join(logDir, "session.log");
  const eventsLogPath = path.join(logDir, "events.ndjson");
  await writePrivateFile(sessionLogPath, "");
  await writePrivateFile(eventsLogPath, "");

  let chain = Promise.resolve();
  let lastError: Error | null = null;

  const enqueue = (operation: () => Promise<void>) => {
    chain = chain.then(operation, operation).catch((error: Error) => {
      lastError = error;
    });
  };

  return {
    eventsLogPath,
    logDir,
    sessionLogPath,
    close: async () => {
      await chain;
      if (lastError) throw lastError;
    },
    event(type, message, payload = {}) {
      const timestamp = clock();
      enqueue(async () => {
        await appendFile(sessionLogPath, `[${formatSessionTime(timestamp)}] ${message}\n`);
        await appendFile(eventsLogPath, `${JSON.stringify({ time: timestamp.toISOString(), type, ...payload })}\n`);
      });
    },
  };
}

function formatSessionTime(date: Date): string {
  return date.toISOString().slice(11, 23);
}
