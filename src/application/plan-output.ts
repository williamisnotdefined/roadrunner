interface FencedBlock {
  content: string;
  info: string;
}

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

function fencedBlocks(output: string): FencedBlock[] {
  const blocks: FencedBlock[] = [];
  const lines = output.replaceAll("\r\n", "\n").split("\n");

  for (let index = 0; index < lines.length; index += 1) {
    const opener = fenceOpener(lines[index]!);
    if (!opener) continue;

    for (let closeIndex = index + 1; closeIndex < lines.length; closeIndex += 1) {
      if (!isFenceCloser(lines[closeIndex]!, opener.marker, opener.length)) continue;
      blocks.push({ info: opener.info, content: lines.slice(index + 1, closeIndex).join("\n") });
      index = closeIndex;
      break;
    }
  }
  return blocks;
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

function fenceOpener(line: string): { info: string; length: number; marker: "`" | "~" } | null {
  const match = /^(?: {0,3})(`{3,}|~{3,})(.*)$/.exec(line);
  if (!match) return null;
  const fence = match[1]!;
  return { info: match[2]!.trim(), length: fence.length, marker: fence[0] as "`" | "~" };
}

function isFenceCloser(line: string, marker: "`" | "~", openerLength: number): boolean {
  const match = /^(?: {0,3})(`{3,}|~{3,})[ \t]*$/.exec(line);
  return Boolean(match && match[1]!.startsWith(marker) && match[1]!.length >= openerLength);
}
