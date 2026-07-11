import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import type { CausalEvent } from "@noopolis/stele";

import type { MemoryWriteSource } from "./report.js";

export interface MemoryBankCounts {
  bank: string;
  events: number;
  recalls: number;
  memory_write_source: MemoryWriteSource;
  /** Per-agent write counts, derived from `memory.written`'s `principal_id`. Only set on the ledger path. */
  writes_by_agent?: Record<string, number>;
}

const AGENT_PRINCIPAL_PATTERN = /^agent:(.+)$/u;

const countJsonlLines = (content: string): string[] =>
  content
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

const countRecallsFromEventsJsonl = (lines: readonly string[]): number =>
  lines.filter((line) => {
    try {
      return (JSON.parse(line) as { type?: string }).type === "memory.recalled";
    } catch {
      return false;
    }
  }).length;

const countByAgent = (events: readonly CausalEvent[]): Record<string, number> => {
  const counts: Record<string, number> = {};
  for (const event of events) {
    const agentId = AGENT_PRINCIPAL_PATTERN.exec(event.principal_id)?.[1];
    if (!agentId) continue;
    counts[agentId] = (counts[agentId] ?? 0) + 1;
  }
  return counts;
};

/**
 * Derives each mneme bank's memory-write count, per-agent write signal, and
 * recall count.
 *
 * Ledger-first (Slice B Piece 4b): mneme stamps a `memory.written` causal
 * event (`noopolis.causal-event.v1`, same `memory/causal.jsonl` stream as
 * `memory.recalled`) on every durable memory register, with
 * `cause_event_ids` chaining it to the wake/turn that produced it. When a
 * bank's reconciled causal stream (`causalEventsByBank`) contains at least
 * one `memory.written` event, that count is authoritative
 * (`memory_write_source: "ledger"`), and `writes_by_agent` is derived from
 * each event's `principal_id`.
 *
 * Fallback (pre-4b runs, e.g. the office-sim golden fixture captured before
 * mneme shipped the write-side event): if a bank's causal stream has ZERO
 * `memory.written` events, this falls back to the interim signal — mneme's
 * own `raw/mneme/<bank>/events.jsonl` bank event log (line count as the
 * write proxy) — marking `memory_write_source: "events-fallback"` so a
 * stale run is visibly on the fallback, never silently. If neither
 * `events.jsonl` nor any `memory.written` event exists, `events` is 0.
 *
 * `recalls` is unaffected by which write source wins: it always prefers
 * `events.jsonl`'s own `memory.recalled` lines when the file exists, falling
 * back to the bank's `memory.recalled` causal events otherwise — the same
 * behavior this function had before Piece 4b.
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
    const bankCausalEvents = causalEventsByBank.get(bank) ?? [];

    const eventsPath = path.join(mnemeDir, bank, "events.jsonl");
    const eventsText = await readFile(eventsPath, "utf8").catch(() => null);
    const eventsJsonlLines = eventsText !== null ? countJsonlLines(eventsText) : null;

    const recalls =
      eventsJsonlLines !== null
        ? countRecallsFromEventsJsonl(eventsJsonlLines)
        : bankCausalEvents.filter((event) => event.type === "memory.recalled").length;

    const ledgerWrites = bankCausalEvents.filter((event) => event.type === "memory.written");

    if (ledgerWrites.length > 0) {
      results.push({
        bank,
        events: ledgerWrites.length,
        recalls,
        memory_write_source: "ledger",
        writes_by_agent: countByAgent(ledgerWrites)
      });
      continue;
    }

    results.push({
      bank,
      events: eventsJsonlLines !== null ? eventsJsonlLines.length : 0,
      recalls,
      memory_write_source: "events-fallback"
    });
  }
  return results.sort((left, right) => left.bank.localeCompare(right.bank));
};
