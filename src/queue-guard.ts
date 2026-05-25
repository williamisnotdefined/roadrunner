import type { ProjectContext } from "./config.js";
import { normalizeQueueFile, type QueueFile, type QueueStep } from "./queue.js";
import { readValidatedQueue } from "./queue-service.js";

export class QueueMutationError extends Error {}

export async function readUnchangedCurrentQueue(context: ProjectContext, expectedQueueFile: QueueFile, step: QueueStep, message: string): Promise<QueueFile> {
  const current = await readQueueForGuard(context, message);
  if (current.queue[0]?.id !== step.id || queueSnapshot(current) !== queueSnapshot(expectedQueueFile)) throw new QueueMutationError(message);
  return current;
}

export async function assertQueueUnchanged(context: ProjectContext, expectedQueueFile: QueueFile, message: string): Promise<void> {
  const current = await readQueueForGuard(context, message);
  if (queueSnapshot(current) !== queueSnapshot(expectedQueueFile)) throw new QueueMutationError(message);
}

function queueSnapshot(queueFile: QueueFile): string {
  return JSON.stringify(normalizeQueueFile(queueFile));
}

async function readQueueForGuard(context: ProjectContext, message: string): Promise<QueueFile> {
  try {
    return await readValidatedQueue(context);
  } catch (error) {
    throw new QueueMutationError(`${message}\n${(error as Error).message}`);
  }
}
