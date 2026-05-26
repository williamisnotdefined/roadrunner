export interface FencedBlock {
  content: string;
  info: string;
}

export function fencedBlocks(output: string): FencedBlock[] {
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

export function fenceOpener(line: string): { info: string; length: number; marker: "`" | "~" } | null {
  const match = /^(?: {0,3})(`{3,}|~{3,})(.*)$/.exec(line);
  if (!match) return null;
  const fence = match[1]!;
  return { info: match[2]!.trim(), length: fence.length, marker: fence[0] as "`" | "~" };
}

export function isFenceCloser(line: string, marker: "`" | "~", openerLength: number): boolean {
  const match = /^(?: {0,3})(`{3,}|~{3,})[ \t]*$/.exec(line);
  return Boolean(match && match[1]!.startsWith(marker) && match[1]!.length >= openerLength);
}
