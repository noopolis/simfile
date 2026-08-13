import type { ElementRef, RunTimeline, TimelineEvent } from "../store/timeline.js";

export type ActionOutcome =
  | "accepted"
  | "rejected"
  | "pending"
  | "fulfilled"
  | "expired"
  | "abandoned"
  | "matched"
  | "unmatched";

export interface ActionFeedRow {
  /** Real event id of the row's most authoritative event (result if present, else attempt). Never synthesized. */
  eventId: string;
  /** Timeline scrub key `t` of that same event — for click-to-scrub. */
  t: number;
  /** The run's own act id, joining an attempt to its result. */
  actId: string;
  /** The tick this action belongs to, as recorded. */
  tick: number;
  /** Who decided — the record's `principal_id`. */
  participant: string;
  /** The body/entity acted through — the record's `actor`. Omitted when equal to `participant` or absent. */
  actor?: string;
  /** What was attempted — the record's `action`. */
  verb: string;
  /** What it was aimed at — the record's `target`. */
  target?: string;
  /** The declaration's recorded `input`, held verbatim and never rewritten. */
  input?: UnknownRecord;
  /** The record's own stated `provenance` of the deciding event, verbatim, never inferred. */
  provenance?: string;
  outcome: ActionOutcome;
  /** Whether this row records declaration admission or its later terminal fact. */
  phase: "action" | "commitment";
  commitmentId?: string;
  /** The participant an addressed commitment was declared to, when the record names one. */
  counterparty?: string;
  /**
   * Where the outcome was decided, when the record says: "at ingress" for
   * `rejected_at_ingress`, "by mechanics" for `rejected_by_mechanics`,
   * "queued, no result recorded" for a pending row. `undefined` for accepted
   * rows and whenever the record states nothing. This is WHERE, not WHY.
   */
  detail?: string;
  /**
   * The record's stated ingress receipt code or mechanics result message.
   * Distinct from `detail` and never inferred; the row outcome determines how
   * presentation labels this value.
   */
  cause?: string;
  /** Explicit apply tick plus the declaration's explicit finite duration. */
  validUntilTick?: number;
  /** The record's own ordering key within the tick, when present. */
  sequence?: number;
}

type ActionAttemptKind = "dynamics.action.queued" | "dynamics.action.rejected_at_ingress";
export type UnknownRecord = Record<string, unknown>;

export interface JoinedAction {
  actId: string;
  attempt?: {
    event: TimelineEvent;
    index: number;
    kind: ActionAttemptKind;
    value: UnknownRecord;
    receipt?: UnknownRecord;
  };
  result?: {
    event: TimelineEvent;
    index: number;
    value: UnknownRecord;
  };
}

const attemptKinds = new Set<string>([
  "dynamics.action.queued",
  "dynamics.action.rejected_at_ingress",
]);

const resultKinds = new Set<string>([
  "dynamics.action.applied",
  "dynamics.action.rejected_by_mechanics",
]);
export const asRecord = (value: unknown): UnknownRecord | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as UnknownRecord)
    : undefined;

export const asString = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

export const asNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

const laterEvent = (
  candidate: { event: TimelineEvent; index: number },
  current: { event: TimelineEvent; index: number } | undefined,
): boolean =>
  !current || candidate.event.t > current.event.t ||
  (candidate.event.t === current.event.t && candidate.index > current.index);

export const valueFrom = (
  result: UnknownRecord | undefined,
  attempt: UnknownRecord | undefined,
  key: string,
): unknown => result?.[key] ?? attempt?.[key];

export const participantRef = (
  timeline: RunTimeline,
  participant: string,
): ElementRef | undefined =>
  timeline.elements.find(({ ref }) =>
    ref === participant || ref === `agent:${participant}`
  )?.ref;

/**
 * Every recorded action of the run, each attempt joined to its own result by
 * the run's `act_id`. Nothing here is synthesized: an entry exists only where
 * the run recorded one.
 */
export const joinRecordedActions = (
  timeline: RunTimeline,
): Map<string, JoinedAction> => {
  const joined = new Map<string, JoinedAction>();

  timeline.events.forEach((event, index) => {
    if (!attemptKinds.has(event.type) && !resultKinds.has(event.type)) return;
    const payload = asRecord(event.payload);
    if (!payload) return;

    if (resultKinds.has(event.type)) {
      const actId = asString(payload.act_id);
      if (!actId) return;
      const entry = joined.get(actId) ?? { actId };
      const candidate = { event, index, value: payload };
      if (laterEvent(candidate, entry.result)) entry.result = candidate;
      joined.set(actId, entry);
      return;
    }

    const attempt = asRecord(payload.attempt);
    const receipt = asRecord(payload.receipt);
    const actId = asString(attempt?.act_id) ?? asString(receipt?.act_id);
    if (!actId || !attempt) return;
    const entry = joined.get(actId) ?? { actId };
    const candidate = {
      event,
      index,
      kind: event.type as ActionAttemptKind,
      value: attempt,
      receipt,
    };
    if (laterEvent(candidate, entry.attempt)) entry.attempt = candidate;
    joined.set(actId, entry);
  });

  return joined;
};

export const summarizeActions = (
  rows: readonly ActionFeedRow[],
): Record<ActionOutcome, number> => {
  const summary: Record<ActionOutcome, number> = {
    abandoned: 0,
    accepted: 0,
    expired: 0,
    fulfilled: 0,
    matched: 0,
    pending: 0,
    rejected: 0,
    unmatched: 0,
  };
  for (const row of rows) summary[row.outcome] += 1;
  return summary;
};
