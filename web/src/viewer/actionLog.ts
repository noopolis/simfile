import type { RunTimeline } from "../store/timeline.js";
import {
  asNumber,
  asRecord,
  asString,
  joinRecordedActions,
  valueFrom,
  type ActionFeedRow,
  type ActionOutcome,
  type JoinedAction,
  type UnknownRecord,
} from "./actionFeed.js";

/**
 * Enough of a commitment's DECLARATION to read its resolution on its own.
 *
 * A commitment is declared at one tick and resolved at another, so in an append
 * log it is two entries far apart. The resolution entry carries this so an
 * observer never meets an outcome with no way to see what it resolved: who
 * declared it, through which body, to whom, what was declared, and when.
 */
export interface ActionLogDeclaration {
  /** Real event id of the declaring action — never synthesized. */
  eventId: string;
  /** Timeline scrub key of the declaration — for click-to-scrub back to it. */
  t: number;
  /** The tick the declaration was applied at. */
  tick: number;
  /** Who declared it — the declaring record's `principal_id`. */
  participant: string;
  /** The body/entity declared through, when the record names a different one. */
  actor?: string;
  /** What was declared — the declaring record's `action`. */
  verb: string;
  /** What the declaration was aimed at — the declaring record's `target`. */
  target?: string;
  /** The declaration's recorded `input`, held verbatim and never rewritten. */
  input?: UnknownRecord;
  /** The declaring record's own stated `provenance`, held verbatim. */
  provenance?: string;
  /** Explicit apply tick plus the declaration's explicit finite duration. */
  validUntilTick?: number;
}

/**
 * One entry of the run's action log. Identical to a feed row, plus the
 * declaration join on a resolution entry.
 */
export interface ActionLogEntry extends ActionFeedRow {
  /** Present only on a `phase: "commitment"` entry the declaration was found for. */
  declaration?: ActionLogDeclaration;
}

/**
 * The run's whole recorded action log, ordered once.
 *
 * This does NOT change as the cursor moves, so it is built once per timeline
 * and a cursor change is a binary search plus a slice (see
 * `actionLogUpToTick`) rather than another rescan of the event stream.
 * `ticks[i]` is `entries[i].tick`, kept alongside so the search never has to
 * touch the entries themselves.
 */
export interface ActionLog {
  readonly entries: readonly ActionLogEntry[];
  /** Non-decreasing `tick` of each entry, in entry order. */
  readonly ticks: readonly number[];
}

interface OrderedEntry {
  readonly entry: ActionLogEntry;
  readonly sourceIndex: number;
}

type JoinedRecord = NonNullable<JoinedAction["attempt"]>
  | NonNullable<JoinedAction["result"]>;

/** The whole event payload, distinct from an attempt payload's nested sub-record. */
const rootPayload = (record: JoinedRecord | undefined): UnknownRecord | undefined =>
  asRecord(record?.event.payload);

const actionProvenance = (entry: JoinedAction): string | undefined =>
  entry.result === undefined
    ? asString(rootPayload(entry.attempt)?.provenance)
    : asString(rootPayload(entry.result)?.provenance);

const commitmentKind = "dynamics.commitment.outcome";
const commitmentOutcomes = new Set<ActionOutcome>([
  "fulfilled", "expired", "abandoned", "matched", "unmatched",
]);

/** The declaration each recorded ordering key belongs to — built once, read many. */
const declarationsBySequence = (
  joined: Map<string, JoinedAction>,
): Map<number, JoinedAction> => {
  const bySequence = new Map<number, JoinedAction>();
  for (const entry of joined.values()) {
    const sequence = asNumber(entry.result?.value.sequence)
      ?? asNumber(entry.attempt?.receipt?.sequence);
    if (sequence === undefined || bySequence.has(sequence)) continue;
    bySequence.set(sequence, entry);
  }
  return bySequence;
};

const declarationContext = (
  entry: JoinedAction,
): ActionLogDeclaration | undefined => {
  const declaring = entry.attempt ?? entry.result;
  const result = entry.result?.value;
  const attempt = entry.attempt?.value;
  const eventId = declaring === undefined
    ? undefined
    : asString(declaring.event.eventId);
  const rawActor = asString(result?.actor) ?? asString(attempt?.actor);
  const participant = asString(result?.principal_id)
    ?? asString(attempt?.principal_id) ?? rawActor;
  const verb = asString(valueFrom(result, attempt, "action"));
  const tick = asNumber(result?.apply_tick)
    ?? asNumber(entry.attempt?.receipt?.apply_tick)
    ?? asNumber(attempt?.at_tick);
  if (declaring === undefined || eventId === undefined || participant === undefined
    || verb === undefined || tick === undefined) return undefined;
  const target = asString(valueFrom(result, attempt, "target"));
  const input = asRecord(attempt?.input);
  const applyTick = asNumber(result?.apply_tick)
    ?? asNumber(entry.attempt?.receipt?.apply_tick);
  const validForTicks = asNumber(input?.valid_for_ticks);
  const validUntilTick = applyTick === undefined || validForTicks === undefined
    ? undefined
    : applyTick + validForTicks;
  const provenance = actionProvenance(entry);
  return {
    ...(rawActor !== undefined && rawActor !== participant
      ? { actor: rawActor }
      : {}),
    eventId,
    participant,
    t: declaring.event.t,
    ...(target === undefined ? {} : { target }),
    ...(input === undefined ? {} : { input }),
    ...(provenance === undefined ? {} : { provenance }),
    tick,
    ...(validUntilTick === undefined || !Number.isFinite(validUntilTick)
      ? {}
      : { validUntilTick }),
    verb,
  };
};

const actionEntries = (joined: Map<string, JoinedAction>): OrderedEntry[] => {
  const rows: OrderedEntry[] = [];
  for (const entry of joined.values()) {
    const result = entry.result?.value;
    const attempt = entry.attempt?.value;
    const receipt = entry.attempt?.receipt;
    const authoritative = entry.result ?? entry.attempt;
    if (!authoritative || !asString(authoritative.event.eventId)) continue;

    const rowTick = result
      ? asNumber(result.apply_tick)
      : asNumber(receipt?.apply_tick) ?? asNumber(attempt?.at_tick);
    if (rowTick === undefined) continue;

    const resultActor = asString(result?.actor);
    const attemptActor = asString(attempt?.actor);
    const rawActor = resultActor ?? attemptActor;
    const participant = result
      ? asString(result.principal_id) ?? resultActor
        ?? asString(attempt?.principal_id) ?? attemptActor
      : asString(attempt?.principal_id) ?? attemptActor;
    const verb = asString(valueFrom(result, attempt, "action"));
    if (!participant || !verb) continue;

    let outcome: ActionOutcome;
    let detail: string | undefined;
    const cause = entry.attempt?.kind === "dynamics.action.rejected_at_ingress"
      ? asString(receipt?.code)
      : asString(result?.message);
    if (result) {
      if (result.accepted === true) {
        outcome = "accepted";
      } else if (result.accepted === false) {
        outcome = "rejected";
        detail = "by mechanics";
      } else {
        continue;
      }
    } else if (entry.attempt?.kind === "dynamics.action.rejected_at_ingress") {
      outcome = "rejected";
      detail = "at ingress";
    } else {
      outcome = "pending";
      detail = "queued, no result recorded";
    }

    const sequence = asNumber(result?.sequence)
      ?? asNumber(receipt?.sequence)
      ?? asNumber(attempt?.sequence);
    const target = asString(valueFrom(result, attempt, "target"));
    const input = asRecord(attempt?.input);
    const applyTick = asNumber(result?.apply_tick) ?? asNumber(receipt?.apply_tick);
    const validForTicks = asNumber(input?.valid_for_ticks);
    const validUntilTick = applyTick === undefined || validForTicks === undefined
      ? undefined
      : applyTick + validForTicks;
    const provenance = actionProvenance(entry);
    rows.push({
      entry: {
        eventId: authoritative.event.eventId,
        t: authoritative.event.t,
        actId: entry.actId,
        tick: rowTick,
        participant,
        ...(rawActor && rawActor !== participant ? { actor: rawActor } : {}),
        verb,
        ...(target !== undefined ? { target } : {}),
        ...(input === undefined ? {} : { input }),
        ...(provenance === undefined ? {} : { provenance }),
        outcome,
        phase: "action",
        ...(detail ? { detail } : {}),
        ...(cause === undefined ? {} : { cause }),
        ...(validUntilTick === undefined || !Number.isFinite(validUntilTick)
          ? {}
          : { validUntilTick }),
        ...(sequence !== undefined ? { sequence } : {}),
      },
      sourceIndex: authoritative.index,
    });
  }
  return rows;
};

const commitmentEntries = (
  timeline: RunTimeline,
  joined: Map<string, JoinedAction>,
): OrderedEntry[] => {
  const bySequence = declarationsBySequence(joined);
  const rows: OrderedEntry[] = [];
  timeline.events.forEach((event, index) => {
    if (event.type !== commitmentKind) return;
    const payload = asRecord(event.payload);
    const tick = asNumber(payload?.tick);
    const declarationSequence = asNumber(payload?.declaration_action_sequence);
    const terminal = asString(payload?.outcome) as ActionOutcome | undefined;
    const participant = asString(payload?.participant);
    const commitmentId = asString(payload?.commitment_id);
    const counterparty = asString(payload?.counterparty);
    const provenance = asString(payload?.provenance);
    if (tick === undefined || declarationSequence === undefined
      || !Number.isSafeInteger(declarationSequence) || declarationSequence <= 0
      || terminal === undefined || !commitmentOutcomes.has(terminal)
      || participant === undefined || commitmentId === undefined
      || !asString(event.eventId)) return;
    const declaration = bySequence.get(declarationSequence);
    if (declaration === undefined) return;
    const result = declaration.result?.value;
    const attempt = declaration.attempt?.value;
    const verb = asString(valueFrom(result, attempt, "action"));
    if (verb === undefined) return;
    const target = asString(valueFrom(result, attempt, "target"));
    const context = declarationContext(declaration);
    rows.push({
      entry: {
        eventId: event.eventId,
        t: event.t,
        actId: declaration.actId,
        tick,
        participant,
        verb,
        ...(target === undefined ? {} : { target }),
        outcome: terminal,
        phase: "commitment",
        ...(provenance === undefined ? {} : { provenance }),
        commitmentId,
        ...(counterparty === undefined ? {} : { counterparty }),
        sequence: declarationSequence,
        ...(context === undefined ? {} : { declaration: context }),
      },
      sourceIndex: index,
    });
  });
  return rows;
};

/**
 * Every recorded action and commitment resolution of the run, in one order:
 * by the tick it belongs to, then by the run's own ordering key within that
 * tick, then by the position the run wrote it at. Nothing is synthesized — an
 * entry exists only where the run recorded one.
 */
export const buildActionLog = (timeline: RunTimeline): ActionLog => {
  const joined = joinRecordedActions(timeline);
  const rows = [...actionEntries(joined), ...commitmentEntries(timeline, joined)];
  rows.sort((left, right) => {
    if (left.entry.tick !== right.entry.tick) {
      return left.entry.tick - right.entry.tick;
    }
    const sequenceDifference = (left.entry.sequence ?? Number.MAX_SAFE_INTEGER)
      - (right.entry.sequence ?? Number.MAX_SAFE_INTEGER);
    if (sequenceDifference !== 0) return sequenceDifference;
    if (left.entry.t !== right.entry.t) return left.entry.t - right.entry.t;
    return left.sourceIndex - right.sourceIndex;
  });
  const entries = rows.map(({ entry }) => entry);
  return { entries, ticks: entries.map(({ tick }) => tick) };
};

/** First index whose tick is strictly greater than `tick`. */
const upperBound = (ticks: readonly number[], tick: number): number => {
  let low = 0;
  let high = ticks.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (ticks[mid]! <= tick) low = mid + 1;
    else high = mid;
  }
  return low;
};

/** First index whose tick is greater than or equal to `tick`. */
const lowerBound = (ticks: readonly number[], tick: number): number => {
  let low = 0;
  let high = ticks.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (ticks[mid]! < tick) low = mid + 1;
    else high = mid;
  }
  return low;
};

/**
 * The log AS OF a cursor: every entry the run recorded at or before `tick`,
 * oldest first, newest last — the transcript that grows as the run plays and
 * truncates when an observer scrubs backwards. A cursor change costs a binary
 * search and a slice, never another pass over the event stream.
 */
export const actionLogUpToTick = (
  log: ActionLog,
  tick: number | undefined,
): readonly ActionLogEntry[] => tick === undefined
  ? []
  : log.entries.slice(0, upperBound(log.ticks, tick));

/** Only the entries the run recorded AT `tick` — the same binary search, both ends. */
export const actionLogAtTick = (
  log: ActionLog,
  tick: number | undefined,
): readonly ActionLogEntry[] => tick === undefined
  ? []
  : log.entries.slice(lowerBound(log.ticks, tick), upperBound(log.ticks, tick));

/**
 * The entries recorded at exactly `tick`, building the log for a single query.
 * Callers that move a cursor should build the log once with `buildActionLog`
 * and slice it instead.
 */
export const actionsAtTick = (
  timeline: RunTimeline,
  tick: number | undefined,
): ActionLogEntry[] => [...actionLogAtTick(buildActionLog(timeline), tick)];
