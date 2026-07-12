import { appendFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { buildCausalFixtureRecords } from "../runtime/causal-fixture.js";
import type { RuntimeTraceEvent, RuntimeVariableSample } from "../runtime/types.js";

export interface WorldLedgerTickInput {
  tick: number;
  tickEvents: readonly RuntimeTraceEvent[];
  sample: RuntimeVariableSample;
  /** Every Moltnet room message id folded into this tick — the determinism
   * contract: without recording exactly which messages a tick ingested,
   * "the world replays byte-identically" would be unfalsifiable. */
  ingestedMessageIds: readonly string[];
}

export interface WorldLedgerWriter {
  causalJsonlPath: string;
  telemetryJsonPath: string;
  ingestedMessagesPath: string;
  appendTick: (input: WorldLedgerTickInput) => Promise<void>;
}

/**
 * Live-loop counterpart of `run-record.ts`'s batch artifact writer, scoped
 * to just the world authority's own stream: appends every tick's minted
 * events to `raw/world/causal.jsonl` in the `noopolis.causal-event.v1` wire
 * shape (via `causal-fixture.ts`'s `toCausalFixtureRecord` — the same
 * mapping B92's conformance harness already validates), grows
 * `world/telemetry.json` with each tick's variable sample, and appends the
 * tick's ingested-message-id list to `world/ingested-messages.jsonl`. All
 * three are real appends (one `appendFile`/rewrite per tick call, not a
 * single write at the end) so the live loop's own on-disk ledger reflects
 * ticks as they happen, matching what the composed driver is meant to be
 * doing here: driving the run, not just producing a side artifact after
 * the fact.
 */
export const createWorldLedgerWriter = async (runDir: string, runId: string): Promise<WorldLedgerWriter> => {
  const worldRawDir = path.join(runDir, "raw", "world");
  const worldDir = path.join(runDir, "world");
  await mkdir(worldRawDir, { recursive: true });
  await mkdir(worldDir, { recursive: true });

  const causalJsonlPath = path.join(worldRawDir, "causal.jsonl");
  const telemetryJsonPath = path.join(worldDir, "telemetry.json");
  const ingestedMessagesPath = path.join(worldDir, "ingested-messages.jsonl");

  await writeFile(causalJsonlPath, "", "utf8");
  await writeFile(ingestedMessagesPath, "", "utf8");

  const samples: RuntimeVariableSample[] = [];

  const appendTick = async (input: WorldLedgerTickInput): Promise<void> => {
    if (input.tickEvents.length > 0) {
      const lines = buildCausalFixtureRecords(input.tickEvents).map((record) => JSON.stringify(record));
      await appendFile(causalJsonlPath, `${lines.join("\n")}\n`, "utf8");
    }

    samples.push(input.sample);
    await writeFile(
      telemetryJsonPath,
      `${JSON.stringify({ run_id: runId, samples, version: "simfile.telemetry.v1" }, null, 2)}\n`,
      "utf8"
    );

    await appendFile(
      ingestedMessagesPath,
      `${JSON.stringify({ tick: input.tick, message_ids: [...input.ingestedMessageIds] })}\n`,
      "utf8"
    );
  };

  return { causalJsonlPath, telemetryJsonPath, ingestedMessagesPath, appendTick };
};
