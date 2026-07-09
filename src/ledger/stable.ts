import { createHash } from "node:crypto";

export type Provenance = "mechanical" | "agentic" | "external";

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
  observedAt?: string;
}

export interface LedgerEventEnvelope<TPayload = unknown> {
  event_id: string;
  kind: string;
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

export const createEventId = (runId: string, seq: number): string => `${runId}:${seq}`;

export const createCanonicalEventEnvelope = <TPayload = unknown>(
  input: LedgerEventEnvelopeInput<TPayload>
): LedgerEventEnvelope<TPayload> => {
  if (!Number.isInteger(input.seq) || input.seq < 0) {
    throw new Error(`seq must be a non-negative integer: ${input.seq}`);
  }
  if (!Number.isFinite(input.simTime)) {
    throw new Error(`simTime must be finite: ${input.simTime}`);
  }

  return {
    event_id: createEventId(input.runId, input.seq),
    kind: input.kind,
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
