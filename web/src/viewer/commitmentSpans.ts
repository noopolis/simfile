import type { RunTimeline } from "../store/timeline.js";
import {
  asNumber,
  asRecord,
  asString,
  joinRecordedActions,
  valueFrom,
  type ActionOutcome,
} from "./actionFeed.js";

/**
 * How a commitment ended, as the run recorded it. `undefined` nowhere: a span
 * either carries a terminal fact the run wrote, or it carries none and is
 * reported as still standing.
 */
export interface CommitmentResolution {
  /** Real event id of the terminating `dynamics.commitment.outcome`. */
  eventId: string;
  /** Timeline scrub key of that event — for click-to-scrub. */
  t: number;
  /** The tick the run recorded the terminal fact at. */
  tick: number;
  outcome: ActionOutcome;
  /** The run's own id for the commitment, named by the terminal record. */
  commitmentId: string;
}

/**
 * A commitment as the thing it actually is: a SPAN. It opens where a
 * participant declared it and closes where the run recorded how it went. At
 * any tick between those two, the commitment is IN FORCE — which is what an
 * observer scrubbing the run needs to see, rather than the two instants at
 * which something happened to be written down.
 */
export interface CommitmentSpan {
  /** Real event id of the declaring action — stable identity for this span. */
  eventId: string;
  /** Timeline scrub key of the declaration — for click-to-scrub. */
  t: number;
  /** The run's own act id for the declaration. */
  actId: string;
  /** The tick the declaration was applied at. */
  declaredAtTick: number;
  /** Who declared it — the record's `principal_id`. */
  participant: string;
  /** The body/entity declared through, when the record names a different one. */
  actor?: string;
  /** What was declared — the record's `action`. */
  verb: string;
  /** What the declaration was aimed at — the record's `target`. */
  target?: string;
  /** Who it was declared TO, when a terminal record names a counterparty. */
  counterparty?: string;
  /** The declaration's own ordering key, which joins it to its terminal fact. */
  sequence: number;
  /** How it ended. Absent while the span is still standing. */
  resolution?: CommitmentResolution;
}

const commitmentKind = "dynamics.commitment.outcome";
const terminalOutcomes = new Set<ActionOutcome>([
  "fulfilled", "expired", "abandoned", "matched", "unmatched",
]);

interface TerminalFact {
  readonly counterparty?: string;
  readonly resolution: CommitmentResolution;
  readonly sourceIndex: number;
}

const terminalFactsBySequence = (
  timeline: RunTimeline,
): Map<number, TerminalFact> => {
  const facts = new Map<number, TerminalFact>();
  timeline.events.forEach((event, index) => {
    if (event.type !== commitmentKind) return;
    const payload = asRecord(event.payload);
    const sequence = asNumber(payload?.declaration_action_sequence);
    const tick = asNumber(payload?.tick);
    const outcome = asString(payload?.outcome) as ActionOutcome | undefined;
    const commitmentId = asString(payload?.commitment_id);
    const eventId = asString(event.eventId);
    if (sequence === undefined || !Number.isSafeInteger(sequence)
      || sequence <= 0 || tick === undefined || outcome === undefined
      || !terminalOutcomes.has(outcome) || commitmentId === undefined
      || eventId === undefined) return;
    const existing = facts.get(sequence);
    // A commitment ends once. Where a run wrote more than one terminal fact for
    // the same declaration, the earliest recorded one is the one that closed it.
    if (existing !== undefined
      && (existing.resolution.tick < tick
        || existing.resolution.tick === tick
        && existing.sourceIndex <= index)) return;
    const counterparty = asString(payload?.counterparty);
    facts.set(sequence, {
      ...(counterparty === undefined ? {} : { counterparty }),
      resolution: { commitmentId, eventId, outcome, t: event.t, tick },
      sourceIndex: index,
    });
  });
  return facts;
};

/**
 * Every commitment the run recorded a declaration for, as a span.
 *
 * A declaration is an accepted action: the run admitted it, so the participant
 * stands on it from that tick. Its terminal fact is the
 * `dynamics.commitment.outcome` the run joined to it by declaration sequence.
 * A declaration the run never wrote a terminal fact for is left OPEN — the run
 * does not say how it went, so neither does this.
 */
export const commitmentSpans = (
  timeline: RunTimeline,
): CommitmentSpan[] => {
  const facts = terminalFactsBySequence(timeline);
  const spans: Array<{ readonly span: CommitmentSpan; readonly index: number }> = [];
  for (const entry of joinRecordedActions(timeline).values()) {
    const result = entry.result?.value;
    const attempt = entry.attempt?.value;
    if (result?.accepted !== true) continue;
    const declaring = entry.attempt ?? entry.result;
    const eventId = declaring === undefined
      ? undefined
      : asString(declaring.event.eventId);
    const sequence = asNumber(result.sequence)
      ?? asNumber(entry.attempt?.receipt?.sequence);
    const declaredAtTick = asNumber(result.apply_tick)
      ?? asNumber(entry.attempt?.receipt?.apply_tick);
    const rawActor = asString(result.actor) ?? asString(attempt?.actor);
    const participant = asString(result.principal_id) ?? rawActor;
    const verb = asString(valueFrom(result, attempt, "action"));
    if (declaring === undefined || eventId === undefined || sequence === undefined
      || !Number.isSafeInteger(sequence) || sequence <= 0
      || declaredAtTick === undefined || participant === undefined
      || verb === undefined) continue;
    const fact = facts.get(sequence);
    const target = asString(valueFrom(result, attempt, "target"));
    spans.push({
      index: declaring.index,
      span: {
        actId: entry.actId,
        ...(rawActor !== undefined && rawActor !== participant
          ? { actor: rawActor }
          : {}),
        ...(fact?.counterparty === undefined
          ? {}
          : { counterparty: fact.counterparty }),
        declaredAtTick,
        eventId,
        participant,
        ...(fact === undefined ? {} : { resolution: fact.resolution }),
        sequence,
        t: declaring.event.t,
        ...(target === undefined ? {} : { target }),
        verb,
      },
    });
  }
  spans.sort((left, right) => {
    if (left.span.declaredAtTick !== right.span.declaredAtTick) {
      return left.span.declaredAtTick - right.span.declaredAtTick;
    }
    if (left.span.sequence !== right.span.sequence) {
      return left.span.sequence - right.span.sequence;
    }
    return left.index - right.index;
  });
  return spans.map(({ span }) => span);
};

/** Whether `span` is in force at `tick` — declared by then, not yet closed. */
export const commitmentSpanInForceAt = (
  span: CommitmentSpan,
  tick: number,
): boolean => span.declaredAtTick <= tick
  && (span.resolution === undefined || tick <= span.resolution.tick);

/**
 * The commitments standing at `tick`. This is what the run says a participant
 * is on the hook for at the cursor, not what happened to be written down there.
 */
export const commitmentsInForceAtTick = (
  timeline: RunTimeline,
  tick: number | undefined,
): CommitmentSpan[] => tick === undefined
  ? []
  : commitmentSpans(timeline).filter((span) =>
    commitmentSpanInForceAt(span, tick));

/**
 * One line of plain text for a span, in the order an observer reads it:
 * who committed, to whom, to what, from when, and how it went.
 */
export const commitmentSpanSummary = (span: CommitmentSpan): string => {
  const to = span.counterparty === undefined ? "" : ` → ${span.counterparty}`;
  const closing = span.resolution === undefined
    ? "standing"
    : `${span.resolution.outcome} t${span.resolution.tick}`;
  return `${span.participant}${to} · ${span.verb} · declared t${span.declaredAtTick} · ${closing}`;
};
