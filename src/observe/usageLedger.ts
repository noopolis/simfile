import { readFile } from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

/**
 * Reads Daimon's per-turn engine usage ledger out of a SEALED run directory.
 *
 * Spawnfile's `artifacts export` egresses the ledger volume to
 * `raw/daimon/usage.jsonl` (plus the rotated `raw/daimon/usage.jsonl.1`), so
 * cost is observable from a torn-down run instead of only from a live
 * container. This module reads those files the same way `memoryBanks.ts` reads
 * `raw/mneme/<bank>/**`: a plain file read of an exported machine-readable
 * artifact. It imports nothing from Spawnfile — the wire record below is
 * re-declared and re-validated here with Simfile's own zod parser, per the
 * repository charter.
 *
 * Observer-tier: this only reads and counts. It never selects, wakes, invokes,
 * or polls agent cognition.
 */

/** The ledger record contract this reader accepts, by its own `v` string. */
export const USAGE_TURN_RECORD_VERSION = "noopolis.daimon.turn-usage.v1" as const;

/** Where the export lands the two generations, relative to the run directory. */
const USAGE_RAW_DIRECTORY = path.join("raw", "daimon");
const USAGE_CURRENT_FILE = "usage.jsonl";
/** ROTATION: `.1` is the OLDER generation and must be read FIRST. */
const USAGE_ROTATED_FILE = "usage.jsonl.1";

const nonNegative = z.number().refine(
  (value) => Number.isFinite(value) && value >= 0,
  "must be a finite non-negative number"
);

/**
 * Simfile's own validation of the wire record — deliberately not an import of
 * Spawnfile's schema. Unknown keys are rejected rather than stripped, and every
 * field is checked rather than coerced, so a malformed line is dropped instead
 * of silently contributing a wrong number.
 */
const usageRecordSchema = z
  .object({
    v: z.literal(USAGE_TURN_RECORD_VERSION),
    agent: z.string().min(1),
    wake: z.string().min(1),
    engine: z.string().min(1),
    at: z.string().min(1).refine((value) => !Number.isNaN(Date.parse(value)), "must be a date"),
    input: nonNegative,
    output: nonNegative,
    cache_read: nonNegative,
    cache_write: nonNegative,
    total: nonNegative,
    calls: nonNegative,
    notional_usd: nonNegative,
    complete: z.boolean()
  })
  .strict();

export type UsageTurnRecord = z.infer<typeof usageRecordSchema>;

/**
 * Parses one ledger line, returning `null` rather than throwing for anything
 * unusable: a blank line, unparseable JSON, a different `v`, or a field that
 * fails validation. A run that crashed mid-append leaves a torn final line,
 * which fails `JSON.parse` and is skipped by exactly this path — the same
 * treatment a garbled line gets.
 */
export const parseUsageLedgerLine = (line: string): UsageTurnRecord | null => {
  const trimmed = line.trim();
  if (trimmed.length === 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  const result = usageRecordSchema.safeParse(parsed);
  return result.success ? result.data : null;
};

export const parseUsageLedger = (content: string): UsageTurnRecord[] =>
  content.split(/\r?\n/u).flatMap((line) => {
    const record = parseUsageLedgerLine(line);
    return record === null ? [] : [record];
  });

export interface UsageAgentTotals {
  agent: string;
  /** The engine this agent opened the window on, from its earliest record. */
  engine: string;
  turns: number;
  tokens: number;
  notional_usd: number;
  /** Turns whose usage block was all zeros: UNKNOWN cost, never free. */
  unknown_turns: number;
}

export interface UsageEngineTotals {
  engine: string;
  turns: number;
  tokens: number;
  notional_usd: number;
}

export interface UsageObservation {
  by_agent: UsageAgentTotals[];
  by_engine: UsageEngineTotals[];
  unknown_turns: number;
}

const sumInto = <T extends { turns: number; tokens: number; notional_usd: number }>(
  target: T,
  record: UsageTurnRecord
): void => {
  target.turns += 1;
  target.tokens += record.total;
  target.notional_usd += record.notional_usd;
};

/**
 * Aggregates already-parsed records per agent and per engine.
 *
 * Records must arrive in chronological order, which is why the reader below
 * concatenates the rotated generation first: an agent's `engine` is taken from
 * the FIRST record seen, so an agent that changed engine mid-run reports the
 * engine it started on rather than whichever generation happened to be read
 * first.
 *
 * `unknown_turns` counts turns the producing decoder could not account for
 * (`complete: false`). Those turns still consumed a subscription; they are
 * surfaced so a reader can see that the totals below them are understated,
 * never dropped and never rendered as free.
 */
export const aggregateUsage = (records: readonly UsageTurnRecord[]): UsageObservation => {
  const byAgent = new Map<string, UsageAgentTotals>();
  const byEngine = new Map<string, UsageEngineTotals>();
  for (const record of records) {
    const agent = byAgent.get(record.agent)
      ?? { agent: record.agent, engine: record.engine, notional_usd: 0, tokens: 0, turns: 0, unknown_turns: 0 };
    sumInto(agent, record);
    if (!record.complete) agent.unknown_turns += 1;
    byAgent.set(record.agent, agent);

    const engine = byEngine.get(record.engine)
      ?? { engine: record.engine, notional_usd: 0, tokens: 0, turns: 0 };
    sumInto(engine, record);
    byEngine.set(record.engine, engine);
  }
  return {
    by_agent: [...byAgent.values()].sort((left, right) => left.agent.localeCompare(right.agent)),
    by_engine: [...byEngine.values()].sort((left, right) => left.engine.localeCompare(right.engine)),
    unknown_turns: [...byAgent.values()].reduce((sum, agent) => sum + agent.unknown_turns, 0)
  };
};

const readGeneration = async (runDir: string, fileName: string): Promise<string | null> => {
  try {
    return await readFile(path.join(runDir, USAGE_RAW_DIRECTORY, fileName), "utf8");
  } catch {
    return null;
  }
};

/**
 * Reads both exported generations and aggregates them.
 *
 * Returns `undefined` — not an empty observation — when the export carries NO
 * usage ledger at all. That distinction is the point: a codex-only organization
 * is never provisioned the ledger volume and legitimately writes nothing, and an
 * export taken before the first metered turn carries nothing either. Neither is
 * evidence that the run was free, so the caller omits the report field entirely
 * rather than publishing a zero. This mirrors how `worldGrants.ts` preserves
 * absence as distinct from a declared none.
 *
 * A ledger that IS present but yields no usable records aggregates to an empty
 * observation, which is a genuine, observed zero.
 */
export const collectUsage = async (runDir: string): Promise<UsageObservation | undefined> => {
  // Rotated (older) FIRST, then current: chronological order across a rotation.
  const [rotated, current] = await Promise.all([
    readGeneration(runDir, USAGE_ROTATED_FILE),
    readGeneration(runDir, USAGE_CURRENT_FILE)
  ]);
  if (rotated === null && current === null) return undefined;
  return aggregateUsage([
    ...parseUsageLedger(rotated ?? ""),
    ...parseUsageLedger(current ?? "")
  ]);
};
