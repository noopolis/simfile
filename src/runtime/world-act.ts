import { createCanonicalEventEnvelope, DEFAULT_EMITTER_STREAM_ID } from "../ledger/stable.js";
import type { RangeSpec } from "./numeric.js";
import { clampAndRound } from "./numeric.js";
import type { QueuedWorldAct, RuntimeTraceEvent, WorldActResult, WorldActRejectionCode } from "./types.js";

/** Simfile's single generic act kind. Its only action at B58 is `variable:set`. */
export const WORLD_ACT_KIND = "world.act" as const;

const MAX_ACT_ID_LENGTH = 128;

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;

/**
 * Malformed acts (missing fields, unknown action, non-numeric value) are
 * transport/schema errors — rejected before ingestion, not surfaced as a
 * `WorldActResult` rejection code.
 */
const assertWellFormedQueuedWorldAct = (act: QueuedWorldAct): void => {
  if (!Number.isInteger(act.at_tick) || act.at_tick < 0) {
    throw new Error(`world.act at_tick must be a non-negative integer: ${String(act.at_tick)}`);
  }
  if (!isNonEmptyString(act.act_id) || act.act_id.length > MAX_ACT_ID_LENGTH) {
    throw new Error("world.act act_id must be a non-empty string of at most 128 characters");
  }
  if (act.action !== "variable:set") {
    throw new Error(`world.act action must be variable:set, got ${String(act.action)}`);
  }
  if (!isNonEmptyString(act.variable)) {
    throw new Error("world.act variable must be a non-empty string");
  }
  if (typeof act.value !== "number") {
    throw new Error(`world.act value must be numeric for act ${act.act_id}`);
  }
  if (!isNonEmptyString(act.actor)) {
    throw new Error("world.act actor must be a non-empty string");
  }
  if (!isNonEmptyString(act.principal_id)) {
    throw new Error("world.act principal_id must be a non-empty string");
  }
  if (act.cause_event_ids !== undefined) {
    if (!Array.isArray(act.cause_event_ids) || act.cause_event_ids.some((id) => !isNonEmptyString(id))) {
      throw new Error("world.act cause_event_ids must be an array of non-empty strings");
    }
  }
};

export interface WorldActValidationContext {
  ticks: number;
  ranges: ReadonlyMap<string, RangeSpec>;
  variableFedBy: ReadonlyMap<string, string>;
  seenActIds: Set<string>;
}

/**
 * Ingestion order (exact, per B58 protocol):
 * 1. dedup (act_id registers on first ingestion regardless of outcome)
 * 2. run_closed (batch: at_tick >= options.ticks)
 * 3. unknown_variable
 * 4. not_authorized (no fed_by, or fed_by !== actor)
 * 5. not_finite / out_of_range (reject, never clamp)
 */
export const validateWorldAct = (
  act: QueuedWorldAct,
  ctx: WorldActValidationContext
): WorldActRejectionCode | undefined => {
  if (ctx.seenActIds.has(act.act_id)) {
    return "duplicate";
  }
  ctx.seenActIds.add(act.act_id);

  if (act.at_tick >= ctx.ticks) {
    return "run_closed";
  }

  const range = ctx.ranges.get(act.variable);
  if (!range) {
    return "unknown_variable";
  }

  const fedBy = ctx.variableFedBy.get(act.variable);
  if (fedBy === undefined || fedBy !== act.actor) {
    return "not_authorized";
  }

  if (!Number.isFinite(act.value)) {
    return "not_finite";
  }

  if (act.value < range.min || act.value > range.max) {
    return "out_of_range";
  }

  return undefined;
};

export interface WorldActIngestion {
  /** Every queued act's result, in original submission (ingress) order. Objects are shared with `resultsByActId` and get their `event_id` filled in as accepted acts are applied. */
  results: WorldActResult[];
  resultsByActId: Map<string, WorldActResult>;
  /** Accepted acts grouped by `at_tick`, preserving ingress order (last write wins on apply). */
  queueByTick: Map<number, QueuedWorldAct[]>;
}

/**
 * Validates every queued act up front (all inputs the checks depend on —
 * declared ranges, declared fed_by, total tick count — are static for a run),
 * without minting any ledger events yet. Accepted acts are grouped by their
 * `at_tick` for `applyWorldActsAtTick` to apply and mint during the trace loop.
 */
export const ingestWorldActs = (
  acts: readonly QueuedWorldAct[],
  ctx: { ticks: number; ranges: ReadonlyMap<string, RangeSpec>; variableFedBy: ReadonlyMap<string, string> }
): WorldActIngestion => {
  const seenActIds = new Set<string>();
  const results: WorldActResult[] = [];
  const resultsByActId = new Map<string, WorldActResult>();
  const queueByTick = new Map<number, QueuedWorldAct[]>();

  for (const act of acts) {
    assertWellFormedQueuedWorldAct(act);
    const code = validateWorldAct(act, {
      ticks: ctx.ticks,
      ranges: ctx.ranges,
      variableFedBy: ctx.variableFedBy,
      seenActIds
    });

    const result: WorldActResult = code
      ? { accepted: false, act_id: act.act_id, code }
      : { accepted: true, act_id: act.act_id, apply_tick: act.at_tick };

    results.push(result);
    resultsByActId.set(act.act_id, result);

    if (!code) {
      const queued = queueByTick.get(act.at_tick) ?? [];
      queued.push(act);
      queueByTick.set(act.at_tick, queued);
    }
  }

  return { results, resultsByActId, queueByTick };
};

export interface ApplyWorldActsContext {
  runId: string;
  precision: number;
  ranges: ReadonlyMap<string, RangeSpec>;
  variableScopes: ReadonlyMap<string, string>;
  resultsByActId: ReadonlyMap<string, WorldActResult>;
  nextSeq: number;
  emit: (event: RuntimeTraceEvent) => void;
}

/**
 * Applies every accepted act queued for this tick, in ingress order (last
 * write wins on shared var/tick). Called at the START of tick processing,
 * after that tick's clock.sync and before generators/derived/rules, so the
 * write lands in `tickState` and the minted event is visible to same-tick
 * `event: world.act` conditions and rules.
 */
export const applyWorldActsAtTick = (
  tick: number,
  simTime: number,
  queuedForTick: readonly QueuedWorldAct[] | undefined,
  tickState: Record<string, number>,
  ctx: ApplyWorldActsContext
): number => {
  if (!queuedForTick || queuedForTick.length === 0) {
    return ctx.nextSeq;
  }

  let seq = ctx.nextSeq;
  for (const act of queuedForTick) {
    const range = ctx.ranges.get(act.variable);
    if (!range) {
      throw new Error(`world.act references unknown variable ${act.variable}`);
    }
    tickState[act.variable] = clampAndRound(act.value, range, ctx.precision);

    const scope = ctx.variableScopes.get(act.variable) ?? "global";
    const payload = {
      sim_time: simTime,
      provenance: "agentic" as const,
      actor: act.actor,
      target: act.variable,
      scope,
      act_id: act.act_id,
      action: act.action,
      value: act.value
    };

    const event = createCanonicalEventEnvelope({
      runId: ctx.runId,
      seq,
      kind: WORLD_ACT_KIND,
      simTime,
      provenance: "agentic",
      actor: act.actor,
      target: act.variable,
      scope,
      payload,
      streamId: DEFAULT_EMITTER_STREAM_ID,
      principalId: act.principal_id,
      causeEventIds: act.cause_event_ids ?? []
    }) as RuntimeTraceEvent;

    ctx.emit(event);

    const result = ctx.resultsByActId.get(act.act_id);
    if (result) {
      result.event_id = event.event_id;
      result.apply_tick = tick;
    }

    seq += 1;
  }

  return seq;
};
