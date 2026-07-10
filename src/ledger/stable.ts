import { createHash } from "node:crypto";

export type Provenance = "mechanical" | "agentic" | "external";

/**
 * Causal envelope constants shared with `specs/causal-event.v1.schema.json`
 * (root, canonical) and `specs/CAUSAL.md`. Simfile does not import that
 * schema file directly — this is simfile's own native TS copy of the wire
 * contract, per the "type sharing" rule: siblings do not vendor the schema,
 * they each hand-write a native type and stay conformant with the wire JSON.
 */
export const CAUSAL_ENVELOPE_VERSION = "noopolis.causal-event.v1" as const;
export const SIMFILE_EMITTER_SYSTEM = "simfile" as const;
export const DEFAULT_EMITTER_STREAM_ID = "world" as const;
export const DEFAULT_PRINCIPAL_ID = "system:simfile.world" as const;

export interface CausalEmitter {
  system: typeof SIMFILE_EMITTER_SYSTEM;
  stream_id: string;
  seq: number;
}

export interface LedgerEventEnvelopeInput<TPayload = unknown> {
  runId: string;
  seq: number;
  kind: string;
  simTime: number;
  provenance: Provenance;
  actor: string;
  target: string;
  scope: string;
  payload: TPayload;
  /** Logical stream within simfile's emitter identity. Defaults to "world". */
  streamId?: string;
  /** Authenticated principal that caused this event. Defaults to "system:simfile.world". */
  principalId?: string;
  /** Direct parent event_ids only (no trace_id, no transitive closure). */
  causeEventIds?: readonly string[];
  /** ISO 8601 diagnostics-only timestamp override. Defaults to a deterministic value derived from simTime. */
  observedAt?: string;
}

export interface LedgerEventEnvelope<TPayload = unknown> {
  /** Causal envelope schema version. Always noopolis.causal-event.v1 once stamped. */
  version?: typeof CAUSAL_ENVELOPE_VERSION;
  /** Identifier shared by every authority participating in a single run. */
  run_id?: string;
  event_id: string;
  /** simfile's emitter identity: system + logical stream + per-stream seq. */
  emitter?: CausalEmitter;
  kind: string;
  /** Authenticated principal that caused this event. Never model-supplied. */
  principal_id?: string;
  /** ISO 8601 timestamp. Diagnostics only; never used to order or trust events. */
  recorded_at?: string;
  /** Direct parent event_ids only. */
  cause_event_ids?: string[];
  sim_time: number;
  provenance: Provenance;
  actor: string;
  target: string;
  scope: string;
  payload: TPayload;
}

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

const asJsonCompatible = (value: unknown): JsonValue => {
  if (value === null) {
    return null;
  }

  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map(asJsonCompatible);
  }

  if (typeof value === "object") {
    const ordered = Object.keys(value as Record<string, unknown>)
      .sort()
      .reduce<Record<string, JsonValue>>((acc, key) => {
        const nested = (value as Record<string, unknown>)[key];
        if (nested !== undefined) {
          acc[key] = asJsonCompatible(nested);
        }
        return acc;
      }, {});
    return ordered;
  }

  return String(value);
}

export const stableStringify = (value: unknown): string => {
  return JSON.stringify(asJsonCompatible(value));
};

/** simfile's event_id convention: `simfile:<runId>:<seq>` (system:local, per the shared schema). */
export const createEventId = (runId: string, seq: number): string =>
  `${SIMFILE_EMITTER_SYSTEM}:${runId}:${seq}`;

const defaultRecordedAt = (simTime: number): string =>
  new Date(Math.max(0, Number.isFinite(simTime) ? simTime : 0) * 1000).toISOString();

export const createCanonicalEventEnvelope = <TPayload = unknown>(
  input: LedgerEventEnvelopeInput<TPayload>
): LedgerEventEnvelope<TPayload> => {
  if (!Number.isInteger(input.seq) || input.seq < 1) {
    throw new Error(`seq must be a positive integer: ${input.seq}`);
  }
  if (!Number.isFinite(input.simTime)) {
    throw new Error(`simTime must be finite: ${input.simTime}`);
  }
  if (input.runId.length === 0) {
    throw new Error("runId must not be empty");
  }

  const streamId = input.streamId ?? DEFAULT_EMITTER_STREAM_ID;
  const principalId = input.principalId ?? DEFAULT_PRINCIPAL_ID;
  const causeEventIds = input.causeEventIds ? [...input.causeEventIds] : [];

  return {
    version: CAUSAL_ENVELOPE_VERSION,
    run_id: input.runId,
    event_id: createEventId(input.runId, input.seq),
    emitter: {
      system: SIMFILE_EMITTER_SYSTEM,
      stream_id: streamId,
      seq: input.seq
    },
    kind: input.kind,
    principal_id: principalId,
    recorded_at: input.observedAt ?? defaultRecordedAt(input.simTime),
    cause_event_ids: causeEventIds,
    sim_time: input.simTime,
    provenance: input.provenance,
    actor: input.actor,
    target: input.target,
    scope: input.scope,
    payload: input.payload
  };
};

export const stableEventLine = <TPayload = unknown>(
  input: LedgerEventEnvelopeInput<TPayload>
): string => stableStringify(createCanonicalEventEnvelope(input));

export const createEventDigest = (input: LedgerEventEnvelopeInput<unknown>): string =>
  createHash("sha256").update(stableEventLine(input)).digest("hex");
