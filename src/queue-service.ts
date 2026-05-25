import { defaultModel, defaultVariant, type ProjectContext } from "./config.js";
import { markBlocked, normalizeQueueFile, readQueue, validateQueueFile, writeQueue, type QueueFile, type QueueStep, type QueueValidationOptions } from "./queue.js";

export function queueValidationOptions(context: ProjectContext): QueueValidationOptions {
  return { model: context.config.model ?? defaultModel, variant: context.config.variant ?? defaultVariant };
}

export function validateQueueState(queueFile: QueueFile, context: ProjectContext): string[] {
  return validateQueueFile(queueFile, queueValidationOptions(context));
}

export async function readValidatedQueue(context: ProjectContext): Promise<QueueFile> {
  const queueFile = await readQueue(context);
  const errors = validateQueueState(queueFile, context);
  if (errors.length > 0) throw new Error(errors.join("\n"));
  return normalizeQueueFile(queueFile);
}

export async function blockStep(context: ProjectContext, queueFile: QueueFile, step: QueueStep, reason: string, { useLatest = true } = {}): Promise<void> {
  const blockedQueue = structuredClone(useLatest ? await queueForBlocking(context, queueFile, step) : queueFile);
  markBlocked(blockedQueue, step.id, reason);
  await writeQueue(blockedQueue, context);
}

async function queueForBlocking(context: ProjectContext, fallbackQueueFile: QueueFile, step: QueueStep): Promise<QueueFile> {
  try {
    const currentQueueFile = await readValidatedQueue(context);
    if (currentQueueFile.queue[0]?.id === step.id) return currentQueueFile;
  } catch {
    return fallbackQueueFile;
  }

  return fallbackQueueFile;
}
