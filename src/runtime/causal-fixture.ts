import { CAUSAL_ENVELOPE_VERSION, DEFAULT_EMITTER_STREAM_ID, DEFAULT_PRINCIPAL_ID, SIMFILE_EMITTER_SYSTEM, type CausalEmitter } from "../ledger/stable.js";
import type { RuntimeTraceEvent } from "./types.js";

export interface CausalFixtureRecord {
  version: typeof CAUSAL_ENVELOPE_VERSION;
  run_id: string;
  event_id: string;
  emitter: CausalEmitter;
  type: string;
  principal_id: string;
  recorded_at: string;
  cause_event_ids: string[];
  payload: Record<string, unknown>;
}

const asWirePayload = (event: RuntimeTraceEvent): Record<string, unknown> => {
  const extra = event.payload && typeof event.payload === "object" && !Array.isArray(event.payload)
    ? event.payload as Record<string, unknown>
    : { value: event.payload };
  return {
    sim_time: event.sim_time,
    provenance: event.provenance,
    actor: event.actor,
    target: event.target,
    scope: event.scope,
    ...extra
  };
};

/**
 * Maps a runtime trace event (simfile's native ledger envelope) onto the
 * noopolis.causal-event.v1 wire shape defined by root's
 * `specs/causal-event.v1.schema.json` (referenced for shape parity, never
 * imported — simfile keeps its own native TS type per the type-sharing rule).
 *
 * This is B92's real entry point: root's conformance harness invokes
 * `npm run emit-causal-fixture` in this package and validates the printed
 * JSONL, line by line, against the schema plus payload minimums.
 */
export const toCausalFixtureRecord = (event: RuntimeTraceEvent): CausalFixtureRecord => ({
  version: event.version ?? CAUSAL_ENVELOPE_VERSION,
  run_id: event.run_id ?? "",
  event_id: event.event_id,
  emitter: event.emitter ?? { system: SIMFILE_EMITTER_SYSTEM, stream_id: DEFAULT_EMITTER_STREAM_ID, seq: 0 },
  type: event.kind,
  principal_id: event.principal_id ?? DEFAULT_PRINCIPAL_ID,
  recorded_at: event.recorded_at ?? new Date(0).toISOString(),
  cause_event_ids: event.cause_event_ids ? [...event.cause_event_ids] : [],
  payload: asWirePayload(event)
});

export const buildCausalFixtureRecords = (events: readonly RuntimeTraceEvent[]): CausalFixtureRecord[] =>
  events.map(toCausalFixtureRecord);
