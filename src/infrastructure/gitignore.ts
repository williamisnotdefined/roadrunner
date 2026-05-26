import { readFile, writeFile } from "node:fs/promises";

import { pathExists } from "./config.js";

const blockStart = "# Roadrunner runtime";
const blockEnd = "# End Roadrunner runtime";

export async function upsertRoadrunnerGitignore(filePath: string, entries: string[]): Promise<void> {
  const uniqueEntries = [...new Set(entries.filter((entry) => entry.length > 0))];
  if (uniqueEntries.length === 0) return;

  const current = (await pathExists(filePath)) ? await readFile(filePath, "utf8") : "";
  const pattern = new RegExp(`${escapeRegExp(blockStart)}\\n([\\s\\S]*?)${escapeRegExp(blockEnd)}\\n?`);
  const match = pattern.exec(current);
  const existingEntries = match ? match[1]!.split("\n").map((entry) => entry.trim()).filter(Boolean) : [];
  const block = `${blockStart}\n${[...new Set([...existingEntries, ...uniqueEntries])].join("\n")}\n${blockEnd}\n`;
  const next = match
    ? current.replace(pattern, block)
    : `${current}${current.length > 0 && !current.endsWith("\n") ? "\n" : ""}${current.length > 0 ? "\n" : ""}${block}`;
  await writeFile(filePath, next);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
