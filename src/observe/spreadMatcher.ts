import { containsAlias } from "../ledger/markers.js";

export const DEFAULT_EDIT_DISTANCE = 2;

export type ParsedSpreadMatcherPolicy =
  | { readonly kind: "exact" }
  | { readonly kind: "edit-distance"; readonly maxDistance: number };

export interface SpreadMatchResult {
  matched: boolean;
  /** Zero for a miss; otherwise the normalized closeness of the best match. */
  fidelity: number;
}

export class UnsupportedSpreadMatcherPolicyError extends Error {
  readonly policy: string;

  constructor(policy: string) {
    super(`unsupported policy in this build: "${policy}" requires an embedding or judge model`);
    this.name = "UnsupportedSpreadMatcherPolicyError";
    this.policy = policy;
  }
}

export class InvalidSpreadMatcherPolicyError extends Error {
  readonly policy: string;

  constructor(policy: string) {
    super(`invalid seed spread matcher policy: "${policy}"`);
    this.name = "InvalidSpreadMatcherPolicyError";
    this.policy = policy;
  }
}

const EDIT_DISTANCE_POLICY = /^edit-distance(?:\s*(?::|<=|≤)\s*(\d+))?$/u;
const EMBEDDING_POLICY = /^embedding(?:$|\s*(?::|>=|≥))/u;

/**
 * Parses the manifest's pinned matcher policy. `edit-distance` defaults to
 * k=2. `edit-distance:<k>` is the canonical parameterized spelling; the
 * contract-style `edit-distance<=<k>` and `edit-distance≤<k>` spellings are
 * accepted too. Bounds must be non-negative safe integers.
 *
 * Embedding/judge spellings are recognized but throw a typed error because
 * this runtime-neutral build has no model with which to execute them.
 */
export const parseSpreadMatcherPolicy = (policy: string): ParsedSpreadMatcherPolicy => {
  const normalized = policy.trim();
  if (normalized === "exact") return { kind: "exact" };

  const editDistance = EDIT_DISTANCE_POLICY.exec(normalized);
  if (editDistance) {
    const maxDistance = editDistance[1] === undefined ? DEFAULT_EDIT_DISTANCE : Number(editDistance[1]);
    if (Number.isSafeInteger(maxDistance)) return { kind: "edit-distance", maxDistance };
    throw new InvalidSpreadMatcherPolicyError(policy);
  }

  if (EMBEDDING_POLICY.test(normalized) || normalized === "judge" || normalized === "judge-model") {
    throw new UnsupportedSpreadMatcherPolicyError(policy);
  }

  throw new InvalidSpreadMatcherPolicyError(policy);
};

/** Standard Levenshtein distance over Unicode code points, not UTF-16 units. */
export const levenshteinDistance = (left: string, right: string): number => {
  const leftPoints = [...left];
  const rightPoints = [...right];
  let previous = Array.from({ length: rightPoints.length + 1 }, (_, index) => index);

  for (let leftIndex = 1; leftIndex <= leftPoints.length; leftIndex += 1) {
    const current = [leftIndex];
    for (let rightIndex = 1; rightIndex <= rightPoints.length; rightIndex += 1) {
      const substitutionCost = leftPoints[leftIndex - 1] === rightPoints[rightIndex - 1] ? 0 : 1;
      current[rightIndex] = Math.min(
        current[rightIndex - 1]! + 1,
        previous[rightIndex]! + 1,
        previous[rightIndex - 1]! + substitutionCost
      );
    }
    previous = current;
  }

  return previous[rightPoints.length]!;
};

const lexicalWords = (value: string): string[] =>
  (value.normalize("NFC").match(/[\p{L}\p{M}\p{N}_]+/gu) ?? []).map((word) => word.toLowerCase());

const codePointLength = (value: string): number => [...value].length;

const bestWindowMatch = (
  textWords: readonly string[],
  seedWords: readonly string[],
  maxDistance: number
): SpreadMatchResult => {
  let matched = false;
  let bestFidelity = 0;
  const normalizedSeed = seedWords.join(" ");
  const seedLength = codePointLength(normalizedSeed);

  for (let start = 0; start < textWords.length; start += 1) {
    const candidateWords: string[] = [];
    for (let end = start; end < textWords.length; end += 1) {
      candidateWords.push(textWords[end]!);
      const candidate = candidateWords.join(" ");
      const candidateLength = codePointLength(candidate);
      if (candidateLength > seedLength + maxDistance) break;
      if (Math.abs(candidateLength - seedLength) > maxDistance) continue;

      const distance = levenshteinDistance(candidate, normalizedSeed);
      if (distance > maxDistance) continue;

      matched = true;
      const denominator = Math.max(candidateLength, seedLength);
      const fidelity = denominator === 0 ? 1 : 1 - distance / denominator;
      bestFidelity = Math.max(bestFidelity, fidelity);
    }
  }

  return { matched, fidelity: matched ? bestFidelity : 0 };
};

const editDistanceMatch = (text: string, tokenSet: readonly string[], maxDistance: number): SpreadMatchResult => {
  const textWords = lexicalWords(text);
  let bestMatch: SpreadMatchResult = { matched: false, fidelity: 0 };

  for (const token of tokenSet) {
    const seedWords = lexicalWords(token);
    if (seedWords.length === 0) continue;

    const aliasMatch = bestWindowMatch(textWords, seedWords, maxDistance);
    if (aliasMatch.matched && (!bestMatch.matched || aliasMatch.fidelity > bestMatch.fidelity)) {
      bestMatch = aliasMatch;
    }
  }

  return bestMatch;
};

/**
 * Finds a seed occurrence under a pinned matcher policy.
 *
 * Exact matching delegates to `containsAlias`, preserving its case-insensitive
 * Unicode word boundaries. Edit-distance matching NFC-normalizes and case-folds
 * lexical words, then compares each token-set entry with viable contiguous text
 * windows (punctuation/whitespace between words normalize to one space). A
 * qualifying pair's fidelity is
 * `1 - distance / max(codePointLength(candidate), codePointLength(seed))`;
 * the highest qualifying fidelity wins.
 */
export const matchSeedSpread = (
  text: string,
  tokenSet: readonly string[],
  matcherPolicy: string | ParsedSpreadMatcherPolicy
): SpreadMatchResult => {
  const policy = typeof matcherPolicy === "string" ? parseSpreadMatcherPolicy(matcherPolicy) : matcherPolicy;

  if (policy.kind === "edit-distance" && (!Number.isSafeInteger(policy.maxDistance) || policy.maxDistance < 0)) {
    throw new InvalidSpreadMatcherPolicyError(JSON.stringify(policy));
  }

  if (policy.kind === "exact") {
    const matched = tokenSet.some((token) => containsAlias(text, token));
    return { matched, fidelity: matched ? 1 : 0 };
  }

  return editDistanceMatch(text, tokenSet, policy.maxDistance);
};
