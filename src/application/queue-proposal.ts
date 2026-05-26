import { normalizeQueueFile, type QueueFile, validateQueueFile } from "../domain/queue.js";
import { defaultModel, defaultVariant, type ProjectContext } from "../infrastructure/config.js";

interface FencedBlock {
  content: string;
  info: string;
}

export function queueProposalFromOutput(output: string, context: ProjectContext): QueueFile {
  const value = parseQueueProposalJson(output);
  const errors = validateQueueFile(value, { model: context.config.model ?? defaultModel, variant: context.config.variant ?? defaultVariant });
  if (errors.length > 0) throw new Error(errors.join("\n"));
  return normalizeQueueFile(value as QueueFile);
}

export function parseQueueProposalJson(output: string): unknown {
  const blocks = fencedBlocks(output);
  const namedBlocks = blocks.filter((block) => block.info.split(/\s+/).includes("roadrunner-queue"));
  const candidates = namedBlocks.length > 0 ? namedBlocks : blocks.filter((block) => block.info.split(/\s+/)[0] === "json");

  if (candidates.length === 0) throw new Error("Provider output must include a fenced JSON block tagged roadrunner-queue.");
  if (candidates.length > 1) throw new Error("Provider output must include exactly one Roadrunner queue JSON proposal.");

  try {
    return JSON.parse(candidates[0]!.content);
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
