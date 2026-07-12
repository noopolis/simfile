import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import type { SeedDeclaration } from "../observe/manifest.js";
import type { Simfile } from "../schema/model.js";

const sha256Hex = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");

/**
 * Every `moltnet:message`/`moltnet:dm` action content string across every
 * world rule (the kickoff included) — the full surface the token lint below
 * checks. Kept as its own export so a test can assert the lint actually
 * looked at every rule, not just the one named `kickoff`.
 */
export const worldRuleMessageContents = (simfile: Simfile): { ruleId: string; content: string }[] => {
  const contents: { ruleId: string; content: string }[] = [];
  for (const [ruleId, rule] of Object.entries(simfile.rules)) {
    for (const action of rule.do) {
      if (action.action === "moltnet:message" || action.action === "moltnet:dm") {
        contents.push({ ruleId, content: action.content });
      }
    }
  }
  return contents;
};

/**
 * Lints every world rule's message content against the memetics
 * `token_set` at run start. A hit here means the WORLD ITSELF would speak a
 * seed token — if that ever happened, any later `marker.seen` on that token
 * would be meaningless (the world can't measure spread of a fact it just
 * announced itself). Returns violation strings; an empty array means the
 * world is clean. Case-insensitive, same as the marker matcher
 * (`../ledger/markers.ts`'s `containsAlias`).
 */
export const lintWorldRuleContentAgainstTokenSet = (
  simfile: Simfile,
  tokenSet: readonly string[]
): string[] => {
  const violations: string[] = [];
  for (const { ruleId, content } of worldRuleMessageContents(simfile)) {
    const lowerContent = content.toLowerCase();
    for (const token of tokenSet) {
      if (lowerContent.includes(token.toLowerCase())) {
        violations.push(`rule "${ruleId}" message content contains seed token "${token}": ${content}`);
      }
    }
  }
  return violations;
};

/** Throws with every violation listed if the world would leak a seed token. */
export const assertWorldRuleContentClean = (simfile: Simfile, tokenSet: readonly string[]): void => {
  const violations = lintWorldRuleContentAgainstTokenSet(simfile, tokenSet);
  if (violations.length > 0) {
    throw new Error(`world rule content lint failed — the world would emit a seed token itself:\n${violations.join("\n")}`);
  }
};

export interface BuildSeedDeclarationOptions {
  /** Absolute path to the seed agent's doc-seeded memory file. */
  memoryDocPath: string;
  tokenSet: readonly string[];
  seedAgent: string;
  seedEpoch: string;
}

/**
 * Builds the `seed_declaration` manifest field (Decision-13) from the
 * agent's own `workspace.docs.memory` file rather than hand-typing the
 * secret line's hash twice: locates the one line containing every
 * `token_set` entry, hashes that exact (trimmed) line, and stamps
 * `matcher_policy: "exact"` / `entry_channel: "doc-seeded"`. Ground truth
 * for the seed lives in this manifest field, never inferred from the
 * substrate — see `../observe/manifest.ts`'s `SeedDeclaration` doc comment.
 */
export const buildSeedDeclarationFromMemoryDoc = async (
  options: BuildSeedDeclarationOptions
): Promise<SeedDeclaration> => {
  const text = await readFile(options.memoryDocPath, "utf8");
  const lines = text.split("\n").map((line) => line.trim()).filter((line) => line.length > 0);
  const seedLine = lines.find((line) => options.tokenSet.every((token) => line.includes(token)));
  if (!seedLine) {
    throw new Error(
      `no line in ${options.memoryDocPath} contains every token_set entry (${options.tokenSet.join(", ")})`
    );
  }

  return {
    content_hash: sha256Hex(seedLine),
    token_set: [...options.tokenSet],
    matcher_policy: "exact",
    seed_agent: options.seedAgent,
    seed_epoch: options.seedEpoch,
    entry_channel: "doc-seeded"
  };
};
