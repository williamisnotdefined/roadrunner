import { normalizeQueueFile, type QueueFile, validateQueueFile } from "../domain/queue.js";
import { defaultModel, defaultVariant, type ProjectContext } from "../infrastructure/config.js";

interface FencedBlock {
  content: string;
  info: string;
}

const queueProposalContract = [
  "## Required Queue Proposal Output",
  "",
  "Your final response must include exactly one fenced JSON block whose info string includes both `json` and `roadrunner-queue`.",
  "The block content must be a complete valid Roadrunner queue JSON object with `version`, `model`, `variant`, `queue`, `history`, and `blocked`.",
  "Every item in `queue`, `history`, and `blocked` must include these required step fields: `id`, `phase`, `title`, `scope`, `prompt`, `acceptance`, and `verification`.",
  "Use `phase` for the roadmap or execution phase, and use `acceptance` for acceptance criteria. Do not substitute aliases such as `roadmapPhase` or `acceptanceCriteria`.",
  "`scope`, `acceptance`, and `verification` must be non-empty string arrays. `id` must be kebab-case. `phase`, `title`, and `prompt` must be non-empty strings.",
  "Closed records may also include `completedAt`, `blockedAt`, and `blockedReason`, but those optional fields do not replace the required step fields.",
  "If no queue changes are needed, return the current queue unchanged in that tagged block. Do not return only prose.",
].join("\n");

export function queueProposalFromOutput(output: string, context: ProjectContext): QueueFile {
  const value = parseQueueProposalJson(output);
  const errors = validateQueueFile(value, { model: context.config.model ?? defaultModel, variant: context.config.variant ?? defaultVariant });
  if (errors.length > 0) throw new Error(errors.join("\n"));
  return normalizeQueueFile(value as QueueFile);
}

export function appendQueueProposalContract(prompt: string): string {
  return `${prompt.trimEnd()}\n\n${queueProposalContract}\n`;
}

export function parseQueueProposalJson(output: string): unknown {
  const blocks = fencedBlocks(output);
  const namedBlocks = blocks.filter((block) => {
    const tokens = block.info.split(/\s+/);
    return tokens.includes("json") && tokens.includes("roadrunner-queue");
  });

  if (namedBlocks.length === 0) throw new Error("Provider output must include a fenced JSON block tagged roadrunner-queue.");
  if (namedBlocks.length > 1) throw new Error("Provider output must include exactly one Roadrunner queue JSON proposal.");

  try {
    return JSON.parse(namedBlocks[0]!.content);
  } catch (error) {
    throw new Error(`Roadrunner queue JSON proposal is invalid: ${(error as Error).message}`);
  }
}

function fencedBlocks(output: string): FencedBlock[] {
  const blocks: FencedBlock[] = [];
  const pattern = /```([^\n`]*)\n([\s\S]*?)\n```/g;
  let match = pattern.exec(output);
  while (match !== null) {
    blocks.push({ info: match[1]!.trim(), content: match[2]! });
    match = pattern.exec(output);
  }
  return blocks;
}
