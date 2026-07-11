import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import type { CausalEvent } from "@noopolis/stele";

import { collectMemoryBankCounts } from "./memoryBanks.js";

const CAUSAL_VERSION = "noopolis.causal-event.v1" as const;

const causalEvent = (overrides: Partial<CausalEvent> & Pick<CausalEvent, "event_id" | "type" | "principal_id">): CausalEvent => ({
  version: CAUSAL_VERSION,
  run_id: "run-unit-test",
  emitter: { system: "mneme", stream_id: "memory:test", seq: 1 },
  recorded_at: "2026-07-11T20:00:00.000Z",
  cause_event_ids: [],
  payload: {},
  ...overrides
});

const makeRunDir = async (banks: Record<string, string | null>): Promise<string> => {
  const runDir = await mkdtemp(path.join(tmpdir(), "simfile-memory-banks-"));
  for (const [bank, eventsJsonl] of Object.entries(banks)) {
    const bankDir = path.join(runDir, "raw", "mneme", bank);
    await mkdir(bankDir, { recursive: true });
    if (eventsJsonl !== null) {
      await writeFile(path.join(bankDir, "events.jsonl"), eventsJsonl, "utf8");
    }
  }
  return runDir;
};

/**
 * Unit-level proof of `collectMemoryBankCounts`'s ledger-first branching
 * (Slice B Piece 4b), isolated from the full `runObserve` pipeline: each
 * case hand-supplies the already-reconciled `causalEventsByBank` map (as
 * `observe.ts` would) and an optional `events.jsonl` fallback file, and
 * asserts which one wins.
 */
describe("collectMemoryBankCounts", () => {
  it("prefers the ledger when memory.written events are present and no events.jsonl exists", async () => {
    const runDir = await makeRunDir({ "ledger-only": null });
    const events = new Map<string, CausalEvent[]>([
      [
        "ledger-only",
        [
          causalEvent({ event_id: "mneme:w1", type: "memory.written", principal_id: "agent:nora" }),
          causalEvent({ event_id: "mneme:w2", type: "memory.written", principal_id: "agent:iris" }),
          causalEvent({ event_id: "mneme:r1", type: "memory.recalled", principal_id: "agent:nora" })
        ]
      ]
    ]);

    const result = await collectMemoryBankCounts(runDir, events);
    assert.deepEqual(result, [
      {
        bank: "ledger-only",
        events: 2,
        recalls: 1,
        memory_write_source: "ledger",
        writes_by_agent: { nora: 1, iris: 1 }
      }
    ]);
  });

  it("falls back to events.jsonl when no memory.written events exist for the bank", async () => {
    const eventsJsonl = [
      { id: "1", type: "memory.claimed" },
      { id: "2", type: "memory.observed" },
      { id: "3", type: "memory.observed" },
      { id: "4", type: "memory.recalled" }
    ]
      .map((line) => JSON.stringify(line))
      .join("\n");
    const runDir = await makeRunDir({ "fallback-only": eventsJsonl });
    const events = new Map<string, CausalEvent[]>([
      ["fallback-only", [causalEvent({ event_id: "mneme:mode1", type: "memory.recall.mode", principal_id: "agent:nora" })]]
    ]);

    const result = await collectMemoryBankCounts(runDir, events);
    assert.deepEqual(result, [
      { bank: "fallback-only", events: 4, recalls: 1, memory_write_source: "events-fallback" }
    ]);
  });

  it("prefers the ledger's write count over a co-existing events.jsonl, but keeps recalls from events.jsonl", async () => {
    const eventsJsonl = [
      { id: "1", type: "memory.claimed" },
      { id: "2", type: "memory.observed" },
      { id: "3", type: "memory.observed" },
      { id: "4", type: "memory.claimed" },
      { id: "5", type: "memory.recalled" }
    ]
      .map((line) => JSON.stringify(line))
      .join("\n");
    const runDir = await makeRunDir({ "ledger-overrides-fallback": eventsJsonl });
    const events = new Map<string, CausalEvent[]>([
      [
        "ledger-overrides-fallback",
        [
          causalEvent({ event_id: "mneme:w1", type: "memory.written", principal_id: "agent:nora" }),
          causalEvent({ event_id: "mneme:w2", type: "memory.written", principal_id: "agent:nora" }),
          causalEvent({ event_id: "mneme:w3", type: "memory.written", principal_id: "agent:iris" })
        ]
      ]
    ]);

    const result = await collectMemoryBankCounts(runDir, events);
    assert.deepEqual(result, [
      {
        bank: "ledger-overrides-fallback",
        events: 3,
        recalls: 1,
        memory_write_source: "ledger",
        writes_by_agent: { nora: 2, iris: 1 }
      }
    ]);
    assert.notEqual(result[0]!.events, 5, "must not report events.jsonl's line count once the ledger has writes");
  });

  it("reports zero writes when neither the ledger nor events.jsonl has a signal", async () => {
    const runDir = await makeRunDir({ empty: null });
    const result = await collectMemoryBankCounts(runDir, new Map());
    assert.deepEqual(result, [{ bank: "empty", events: 0, recalls: 0, memory_write_source: "events-fallback" }]);
  });
});
