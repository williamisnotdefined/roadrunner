import { fencedBlocks, fenceOpener, isFenceCloser } from "./markdown-fences.js";

export class PlanOutputError extends Error {}

export function planMarkdownFromOutput(output: string): string {
  const namedBlocks = fencedBlocks(output).filter((block) => {
    const tokens = block.info.split(/\s+/);
    return tokens.includes("md") && tokens.includes("roadrunner-plan");
  });

  if (namedBlocks.length === 0) throw new PlanOutputError("Provider output must include a fenced Markdown block tagged roadrunner-plan.");
  if (namedBlocks.length > 1) throw new PlanOutputError("Provider output must include exactly one Roadrunner plan block.");

  const planMarkdown = namedBlocks[0]!.content.trim();
  if (planMarkdown.length === 0) throw new PlanOutputError("Roadrunner plan block must not be empty.");
  if (containsUnclosedFence(planMarkdown)) throw new PlanOutputError("Roadrunner plan block contains an unclosed nested fence; use a longer outer fence or avoid nested fences.");
  return planMarkdown;
}

function containsUnclosedFence(markdown: string): boolean {
  const lines = markdown.replaceAll("\r\n", "\n").split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const opener = fenceOpener(lines[index]!);
    if (!opener) continue;

    let closed = false;
    for (let closeIndex = index + 1; closeIndex < lines.length; closeIndex += 1) {
      if (!isFenceCloser(lines[closeIndex]!, opener.marker, opener.length)) continue;
      index = closeIndex;
      closed = true;
      break;
    }
    if (!closed) return true;
  }
  return false;
}
