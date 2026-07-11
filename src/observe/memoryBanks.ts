import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import type { CausalEvent } from "@noopolis/stele";

export interface MemoryBankCounts {
  bank: string;
  events: number;
  recalls: number;
}

const countJsonlLines = (content: string): string[] =>
  content
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

/**
 * Reads `raw/mneme/<bank>/events.jsonl` — mneme's own bank event log, NOT
 * the `noopolis.causal-event.v1` envelope — for the memory-write signal.
 * This is a deliberate, flagged gap: mneme's causal envelope currently only
 * stamps `memory.recall.mode`/`memory.recalled` (read-side telemetry); there
 * is no `memory.write`-family causal event type yet (contracts.md's
 * `mneme.memory-export.v1` is still "new", not shipped). Until that lands,
 * the write count for a bank comes from its own event log file, the same
 * file `officeSim.ts`'s `readMemoryEvidence` already reads for the
 * equivalent monolith assertion. If a future fixture ships a bank directory
 * with no `events.jsonl` (only `causal.jsonl`), this falls back to counting
 * that bank's own `memory.recalled` causal events for `recalls`, with
 * `events` left at 0 (no reconcilable write signal exists yet in that case).
 */
export const collectMemoryBankCounts = async (
  runDir: string,
  causalEventsByBank: ReadonlyMap<string, CausalEvent[]>
): Promise<MemoryBankCounts[]> => {
  const mnemeDir = path.join(runDir, "raw", "mneme");
  const bankDirs = await readdir(mnemeDir, { withFileTypes: true }).catch(() => []);

  const results: MemoryBankCounts[] = [];
  for (const entry of bankDirs) {
    if (!entry.isDirectory()) continue;
    const bank = entry.name;
    const eventsPath = path.join(mnemeDir, bank, "events.jsonl");
    const eventsText = await readFile(eventsPath, "utf8").catch(() => null);

    if (eventsText !== null) {
      const lines = countJsonlLines(eventsText);
      const recalls = lines.filter((line) => {
        try {
          return (JSON.parse(line) as { type?: string }).type === "memory.recalled";
        } catch {
          return false;
        }
      }).length;
      results.push({ bank, events: lines.length, recalls });
      continue;
    }

    const causalRecalls = (causalEventsByBank.get(bank) ?? []).filter(
      (event) => event.type === "memory.recalled"
    ).length;
    results.push({ bank, events: 0, recalls: causalRecalls });
  }
  return results.sort((left, right) => left.bank.localeCompare(right.bank));
};
