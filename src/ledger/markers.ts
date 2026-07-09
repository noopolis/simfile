export interface LedgerEvent {
  event_id?: string;
  kind: string;
  sim_time?: number;
  actor?: string;
  target?: string;
  scope?: string;
  payload?: unknown;
}

export interface MarkerDefinition {
  text?: string[];
  mode: "containment" | "propagation";
  scopes: string[];
}

export interface MarkerHit {
  markerId: string;
  eventId: string;
  eventKind: string;
  scope: string;
  simTime: number;
  alias: string;
}

export interface MarkerScanResult {
  markerId: string;
  hits: MarkerHit[];
}

export interface MarkerCoverageResult {
  markerId: string;
  mode: "containment" | "propagation";
  passed: boolean;
  evidence: string[];
  detail: string;
}

interface NormalizedHit {
  eventId: string;
  scope: string;
}

const normalizeAlias = (text: string): string => text.trim().toLocaleLowerCase();

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

const containsAlias = (payload: string, alias: string): boolean => {
  const boundary = "(?<![\\p{L}\\p{N}_])";
  const endBoundary = "(?![\\p{L}\\p{N}_])";
  return new RegExp(`${boundary}${escapeRegExp(alias)}${endBoundary}`, "iu").test(payload);
};

const extractTextCandidates = (payload: unknown): string[] => {
  if (typeof payload === "string") {
    return [payload];
  }

  if (!payload || typeof payload !== "object") {
    return [];
  }

  const record = payload as Record<string, unknown>;
  const fields = ["content", "text", "message", "body"];
  const values = fields
    .map((field) => record[field])
    .filter((entry): entry is string => typeof entry === "string");
  if (values.length > 0) {
    return values;
  }

  if (typeof record.content === "object" && record.content !== null && "text" in record.content) {
    const nested = (record.content as Record<string, unknown>).text;
    if (typeof nested === "string") {
      return [nested];
    }
  }

  return [];
};

const eventScope = (event: LedgerEvent): string => event.scope ?? event.target ?? "global";
const eventIdForHit = (event: LedgerEvent, fallback: string): string => event.event_id ?? fallback;

export const scanMarker = (
  events: readonly LedgerEvent[],
  markerId: string,
  marker: MarkerDefinition
): MarkerScanResult => {
  const aliases = (marker.text && marker.text.length > 0 ? marker.text : [markerId]).map(normalizeAlias);
  const hits = new Map<string, MarkerHit>();

  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    const payloadText = extractTextCandidates(event.payload).join(" ");
    const lowerPayload = payloadText.toLocaleLowerCase();
    const matchedAlias = aliases.find((alias) => containsAlias(lowerPayload, alias));
    if (!matchedAlias) {
      continue;
    }

    const normalized: NormalizedHit = {
      eventId: eventIdForHit(event, `index:${index}`),
      scope: eventScope(event)
    };
    const key = normalized.eventId;
    if (hits.has(key)) {
      continue;
    }

    hits.set(key, {
      markerId,
      eventId: normalized.eventId,
      eventKind: event.kind,
      scope: normalized.scope,
      simTime: event.sim_time ?? 0,
      alias: matchedAlias
    });
  }

  return {
    markerId,
    hits: [...hits.values()]
  };
};

export const scanMarkers = (
  events: readonly LedgerEvent[],
  markers: Record<string, MarkerDefinition>
): Record<string, MarkerHit[]> => {
  const output: Record<string, MarkerHit[]> = {};
  for (const [markerId, marker] of Object.entries(markers)) {
    const result = scanMarker(events, markerId, marker);
    output[markerId] = result.hits;
  }
  return output;
};

const withinScope = (scope: string, scopes: readonly string[]): boolean => scopes.includes(scope);

export const evaluateContainmentMarker = (
  markerId: string,
  marker: MarkerDefinition,
  hits: readonly MarkerHit[]
): MarkerCoverageResult => {
  const inScope = hits.filter((hit) => withinScope(hit.scope, marker.scopes));
  const outOfScope = hits.filter((hit) => !withinScope(hit.scope, marker.scopes));
  const passed = inScope.length > 0 && outOfScope.length === 0;
  return {
    markerId,
    mode: "containment",
    passed,
    evidence: hits.map((hit) => hit.eventId),
    detail: passed
      ? "contained marker stayed within declared scopes"
      : "marker violated containment policy"
  };
};

export interface EvaluatePropagationOptions {
  requireAllScopes?: boolean;
}

export const evaluatePropagationMarker = (
  markerId: string,
  marker: MarkerDefinition,
  hits: readonly MarkerHit[],
  options: EvaluatePropagationOptions = {}
): MarkerCoverageResult => {
  const inScope = hits.filter((hit) => withinScope(hit.scope, marker.scopes));
  const required = options.requireAllScopes === true;

  const passed = required
    ? marker.scopes.every((scope) => inScope.some((hit) => hit.scope === scope))
    : inScope.length > 0;

  return {
    markerId,
    mode: "propagation",
    passed,
    evidence: inScope.map((hit) => hit.eventId),
    detail: passed
      ? "marker reached required propagation scope(s)"
      : "marker did not reach required propagation scope(s)"
  };
};
