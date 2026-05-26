import type { QueueFile, QueueStep } from "./queue.js";

export interface VerificationPolicyInput {
  allowedCommands?: readonly string[];
  proposed: QueueFile;
  trustedCommands?: readonly string[];
}

interface UntrustedVerificationCommand {
  collection: string;
  command: string;
  commandIndex: number;
  step: QueueStep;
  stepIndex: number;
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
  const untrusted: UntrustedVerificationCommand[] = [];

  for (const [collection, steps] of Object.entries({ queue: proposed.queue, history: proposed.history, blocked: proposed.blocked })) {
    for (const [stepIndex, step] of steps.entries()) {
      for (const [commandIndex, command] of step.verification.entries()) {
        if (trusted.has(command)) continue;
        untrusted.push({ collection, command, commandIndex, step, stepIndex });
      }
    }
  }

  return untrusted.length > 0 ? [formatUntrustedVerificationCommands(untrusted)] : [];
}

function formatUntrustedVerificationCommands(commands: UntrustedVerificationCommand[]): string {
  return [
    "Verification commands were rejected before execution.",
    "",
    "Roadrunner only runs verification commands that were already present in the roadmap/current queue or explicitly allowed in roadrunner.config.json.",
    "",
    "Untrusted commands:",
    ...commands.map(formatUntrustedCommand),
    "",
    "How to fix:",
    "1. Review each command.",
    "2. If expected, add the exact command strings to allowedVerificationCommands in roadrunner.config.json.",
    "3. Or define them directly in the operational roadmap.",
    "4. Restart the Roadrunner run.",
  ].join("\n");
}

function formatUntrustedCommand({ collection, command, commandIndex, step, stepIndex }: UntrustedVerificationCommand): string {
  const stepId = step.id ? ` ${step.id}` : "";
  return `- ${collection}[${stepIndex}]${stepId} verification[${commandIndex}]: ${command}`;
}

function allSteps(queueFile: QueueFile): QueueStep[] {
  return [...queueFile.queue, ...queueFile.history, ...queueFile.blocked];
}
