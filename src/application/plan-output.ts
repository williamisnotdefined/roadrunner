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
  return planMarkdown;
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
