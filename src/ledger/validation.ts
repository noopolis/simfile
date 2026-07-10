import {
  createEventId,
  stableStringify,
  CAUSAL_ENVELOPE_VERSION,
  SIMFILE_EMITTER_SYSTEM,
  type CausalEmitter,
  type LedgerEventEnvelope,
  type Provenance
} from "./stable.js";

export interface CanonicalLedgerValidationOptions {
  runId?: string;
  /** Restrict validation to a single emitter stream (defaults to accepting any). */
  streamId?: string;
}

const provenanceValues = new Set<Provenance>(["mechanical", "agentic", "external"]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const requireString = (event: Record<string, unknown>, key: string, index: number): string => {
  const value = event[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`ledger event ${index} has invalid ${key}`);
  }
  return value;
};

const requireStringArray = (event: Record<string, unknown>, key: string, index: number): string[] => {
  const value = event[key];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || entry.length === 0)) {
    throw new Error(`ledger event ${index} has invalid ${key}`);
  }
  return value as string[];
};

const requirePayload = (event: Record<string, unknown>, index: number): unknown => {
  if (!Object.hasOwn(event, "payload") || event.payload === undefined) {
    throw new Error(`ledger event ${index} is missing payload`);
  }
  return event.payload;
};

const requireEmitter = (event: Record<string, unknown>, index: number): CausalEmitter => {
  const emitter = event.emitter;
  if (!isRecord(emitter)) {
    throw new Error(`ledger event ${index} has invalid emitter`);
  }
  if (emitter.system !== SIMFILE_EMITTER_SYSTEM) {
    throw new Error(`ledger event ${index} has invalid emitter.system`);
  }
  const streamId = emitter.stream_id;
  if (typeof streamId !== "string" || streamId.length === 0) {
    throw new Error(`ledger event ${index} has invalid emitter.stream_id`);
  }
  const seq = emitter.seq;
  if (typeof seq !== "number" || !Number.isInteger(seq) || seq < 1) {
    throw new Error(`ledger event ${index} has invalid emitter.seq`);
  }
  return { system: SIMFILE_EMITTER_SYSTEM, stream_id: streamId, seq };
};

/**
 * Validates and normalizes a stream of simfile causal ledger envelopes.
 *
 * Contiguity is generalized to (run_id, stream_id): every emitter.seq must be
 * 1-based and contiguous within its own (run_id, stream_id) group, even if
 * multiple streams are interleaved across the input array.
 */
export const validateCanonicalLedgerEvents = (
  events: readonly unknown[],
  options: CanonicalLedgerValidationOptions = {}
): LedgerEventEnvelope[] => {
  let runId = options.runId;
  const nextSeqByStream = new Map<string, number>();

  return events.map((event, index) => {
    if (!isRecord(event)) {
      throw new Error(`ledger event ${index} is not an object`);
    }

    const version = event.version;
    if (version !== CAUSAL_ENVELOPE_VERSION) {
      throw new Error(`ledger event ${index} has invalid version`);
    }

    const eventRunId = requireString(event, "run_id", index);
    runId ??= eventRunId;
    if (eventRunId !== runId) {
      throw new Error(`ledger event ${index} has mismatched run_id`);
    }

    const emitter = requireEmitter(event, index);
    if (options.streamId !== undefined && emitter.stream_id !== options.streamId) {
      throw new Error(`ledger event ${index} has unexpected emitter.stream_id`);
    }

    const streamKey = `${runId} ${emitter.stream_id}`;
    const expectedSeq = (nextSeqByStream.get(streamKey) ?? 0) + 1;
    if (emitter.seq !== expectedSeq) {
      throw new Error(`ledger event ${index} has non-contiguous seq for (run_id, stream_id)`);
    }
    nextSeqByStream.set(streamKey, emitter.seq);

    const eventId = requireString(event, "event_id", index);
    if (eventId !== createEventId(runId, emitter.seq)) {
      throw new Error(`ledger event ${index} has invalid event_id`);
    }

    const principalId = requireString(event, "principal_id", index);
    const recordedAt = requireString(event, "recorded_at", index);
    if (Number.isNaN(Date.parse(recordedAt))) {
      throw new Error(`ledger event ${index} has invalid recorded_at`);
    }
    const causeEventIds = requireStringArray(event, "cause_event_ids", index);

    const simTime = event.sim_time;
    if (typeof simTime !== "number" || !Number.isFinite(simTime)) {
      throw new Error(`ledger event ${index} has invalid sim_time`);
    }

    const provenance = requireString(event, "provenance", index);
    if (!provenanceValues.has(provenance as Provenance)) {
      throw new Error(`ledger event ${index} has invalid provenance`);
    }

    return {
      version: CAUSAL_ENVELOPE_VERSION,
      run_id: runId,
      event_id: eventId,
      emitter,
      kind: requireString(event, "kind", index),
      principal_id: principalId,
      recorded_at: recordedAt,
      cause_event_ids: causeEventIds,
      sim_time: simTime,
      provenance: provenance as Provenance,
      actor: requireString(event, "actor", index),
      target: requireString(event, "target", index),
      scope: requireString(event, "scope", index),
      payload: requirePayload(event, index)
    };
  });
};

export const parseCanonicalLedgerJsonl = (
  source: string,
  options: CanonicalLedgerValidationOptions = {}
): LedgerEventEnvelope[] => {
  const lines = source.split(/\r?\n/u).filter((line) => line.length > 0);
  const parsed = lines.map((line, index) => {
    let value: unknown;
    try {
      value = JSON.parse(line) as unknown;
    } catch (error) {
      throw new Error(`ledger line ${index} is not valid JSON: ${(error as Error).message}`);
    }
    if (stableStringify(value) !== line) {
      throw new Error(`ledger line ${index} is not canonical JSON`);
    }
    return value;
  });
  return validateCanonicalLedgerEvents(parsed, options);
};
