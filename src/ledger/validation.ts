import { stableStringify, type LedgerEventEnvelope, type Provenance } from "./stable.js";

export interface CanonicalLedgerValidationOptions {
  runId?: string;
}

const provenanceValues = new Set<Provenance>(["mechanical", "agentic", "external"]);
const eventIdPattern = /^(.*):([0-9]+)$/u;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const requireString = (event: Record<string, unknown>, key: string, index: number): string => {
  const value = event[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`ledger event ${index} has invalid ${key}`);
  }
  return value;
};

const requirePayload = (event: Record<string, unknown>, index: number): unknown => {
  if (!Object.hasOwn(event, "payload") || event.payload === undefined) {
    throw new Error(`ledger event ${index} is missing payload`);
  }
  return event.payload;
};

export const validateCanonicalLedgerEvents = (
  events: readonly unknown[],
  options: CanonicalLedgerValidationOptions = {}
): LedgerEventEnvelope[] => {
  let runId = options.runId;

  return events.map((event, index) => {
    if (!isRecord(event)) {
      throw new Error(`ledger event ${index} is not an object`);
    }

    const eventId = requireString(event, "event_id", index);
    const match = eventId.match(eventIdPattern);
    if (!match) {
      throw new Error(`ledger event ${index} has invalid event_id`);
    }

    runId ??= match[1];
    const seq = Number(match[2]);
    if (match[1] !== runId || seq !== index + 1) {
      throw new Error(`ledger event ${index} has non-contiguous event_id`);
    }

    const simTime = event.sim_time;
    if (typeof simTime !== "number" || !Number.isFinite(simTime)) {
      throw new Error(`ledger event ${index} has invalid sim_time`);
    }

    const provenance = requireString(event, "provenance", index);
    if (!provenanceValues.has(provenance as Provenance)) {
      throw new Error(`ledger event ${index} has invalid provenance`);
    }

    return {
      event_id: eventId,
      kind: requireString(event, "kind", index),
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
