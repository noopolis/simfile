import { readFile } from "node:fs/promises";

import { parseCausalJsonl, type CausalEvent, type CausalJsonlParseError } from "@noopolis/stele";

import { findRunRawFiles, rawAuthority } from "./rawFiles.js";

export interface CausalStreamSource {
  /** The authority directory name directly under a `raw/` namespace. */
  authority: string;
  errors: CausalJsonlParseError[];
  events: CausalEvent[];
  /** Path relative to the run directory. */
  relativePath: string;
}

/**
 * Reads and parses every discoverable `raw/<authority>/.../causal.jsonl`.
 * Top-level raw trees retain their legacy behavior; nested raw artifacts are
 * admitted only through the sealed manifest (`rawFiles.ts`). Never reads any
 * other file kind here.
 */
export const collectCausalStreams = async (runDir: string): Promise<CausalStreamSource[]> => {
  const files = (await findRunRawFiles(runDir))
    .filter(({ rawRelativePath }) => rawRelativePath.endsWith("causal.jsonl"));

  const sources: CausalStreamSource[] = [];
  for (const file of files) {
    const authority = rawAuthority(file.rawRelativePath);
    const text = await readFile(file.absolutePath, "utf8");
    const { errors, events } = parseCausalJsonl(text);
    sources.push({ authority, errors, events, relativePath: file.relativePath });
  }
  return sources;
};
