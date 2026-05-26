import type { QueueFile, QueueStep } from "./queue.js";

export interface VerificationPolicyInput {
  allowedCommands?: readonly string[];
  proposed: QueueFile;
  trustedCommands?: readonly string[];
}

export function trustedVerificationCommands(...queueFiles: QueueFile[]): string[] {
  const commands = new Set<string>();
  for (const queueFile of queueFiles) {
    for (const step of allSteps(queueFile)) {
      for (const command of step.verification) commands.add(command);
    }
  }
  return [...commands];
}

export function validateVerificationPolicy({ allowedCommands = [], proposed, trustedCommands = [] }: VerificationPolicyInput): string[] {
  const trusted = new Set([...trustedCommands, ...allowedCommands]);
  const errors: string[] = [];

  for (const [collection, steps] of Object.entries({ queue: proposed.queue, history: proposed.history, blocked: proposed.blocked })) {
    for (const [stepIndex, step] of steps.entries()) {
      for (const [commandIndex, command] of step.verification.entries()) {
        if (trusted.has(command)) continue;
        errors.push(`${collection}[${stepIndex}].verification[${commandIndex}] is not trusted. Define verification commands in the roadmap or add exact commands to allowedVerificationCommands.`);
      }
    }
  }

  return errors;
}

function allSteps(queueFile: QueueFile): QueueStep[] {
  return [...queueFile.queue, ...queueFile.history, ...queueFile.blocked];
}
