import type { LedgerEventEnvelope } from "../ledger/stable.js";

/**
 * A world.act queued for deterministic ingestion at a given tick. This is the
 * B58 driver stand-in for a live agent tool call: `run_id`, `actor`,
 * `principal_id`, and `cause_event_ids` are trusted-injection fields (never
 * model-supplied); `act_id`, `action`, `variable`, `value` are the only
 * model-authored fields per the `world_act` tool surface.
 */
export interface QueuedWorldAct {
  at_tick: number;
  act_id: string;
  action: "variable:set";
  variable: string;
  value: number;
  actor: string;
  principal_id: string;
  cause_event_ids?: string[];
}

/** Rejection codes for a queued world.act, in ingestion check order. */
export type WorldActRejectionCode =
  | "unknown_variable"
  | "not_authorized"
  | "out_of_range"
  | "not_finite"
  | "duplicate"
  | "run_closed";

/** Tool-facing outcome of ingesting a single queued world.act. */
export interface WorldActResult {
  accepted: boolean;
  act_id: string;
  event_id?: string;
  apply_tick?: number;
  code?: WorldActRejectionCode;
}

export interface RuntimeOptions {
  runId: string;
  seed: string;
  ticks: number;
  precision?: number;
  worldActs?: readonly QueuedWorldAct[];
}

export type RuntimeTraceEventPayload = Record<string, unknown> | Array<unknown> | string | number | boolean | null;

/**
 * A single runtime-emitted trace event. This is a `LedgerEventEnvelope`: every
 * event produced by `runSimfileTrace` carries the full causal envelope
 * (version, run_id, emitter, principal_id, recorded_at, cause_event_ids) —
 * those fields are typed optional here only so hand-written fixtures in other
 * modules' tests (which predate the causal envelope) keep type-checking.
 */
export type RuntimeTraceEvent = LedgerEventEnvelope<RuntimeTraceEventPayload>;

export interface RuntimeVariableSample {
  occupancy: Record<string, string[]>;
  transit: TransitSample[];
  phase: string | undefined;
  sim_time: number;
  tick: number;
  variables: Record<string, number>;
}

/** Canonical per-sample view of an agent that currently occupies no place. */
export interface TransitSample {
  agent: string;
  from: string;
  to: string;
  ticksRemaining: number;
}

/** Mutable runtime form; arrivalTick makes replay timing explicit. */
export interface TransitState {
  agent: string;
  from: string;
  to: string;
  arrivalTick: number;
}

export interface RuntimeTrace {
  runId: string;
  seed: string;
  ticks: number;
  variables: Record<string, number>;
  events: RuntimeTraceEvent[];
  samples: RuntimeVariableSample[];
  diagnostics: string[];
  actResults: WorldActResult[];
}
