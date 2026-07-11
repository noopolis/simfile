import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { parseCausalJsonl, type CausalEvent, type CausalJsonlParseError } from "@noopolis/stele";

export interface CausalStreamSource {
  /** The authority directory name directly under `raw/` (e.g. "moltnet", "daimon", "mneme"). */
  authority: string;
  errors: CausalJsonlParseError[];
  events: CausalEvent[];
  /** Path relative to the run directory. */
  relativePath: string;
}

const walkFiles = async (root: string): Promise<string[]> => {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const files: string[] = [];
  for (const entry of entries) {
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walkFiles(entryPath)));
    } else if (entry.isFile()) {
      files.push(entryPath);
    }
  }
  return files;
};

/**
 * Reads and parses every `causal.jsonl` file under `<runDir>/raw/**`,
 * tagging each stream by the authority directory it lives under
 * (`raw/<authority>/...causal.jsonl`). Never reads any other file kind here
 * — that keeps this module a single-purpose causal-stream collector; other
 * per-authority artifacts (transcripts, bank event logs) are read by their
 * own modules.
 */
export const collectCausalStreams = async (runDir: string): Promise<CausalStreamSource[]> => {
  const rawDir = path.join(runDir, "raw");
  const files = (await walkFiles(rawDir)).filter((file) => file.endsWith("causal.jsonl")).sort();

  const sources: CausalStreamSource[] = [];
  for (const file of files) {
    const relativePath = path.relative(runDir, file);
    const authority = relativePath.split(path.sep)[1] ?? "unknown";
    const text = await readFile(file, "utf8");
    const { errors, events } = parseCausalJsonl(text);
    sources.push({ authority, errors, events, relativePath });
  }
  return sources;
};
