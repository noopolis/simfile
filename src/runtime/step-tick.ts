import { drawUniform } from "../kernel/stochastic.js";
import { createCanonicalEventEnvelope, DEFAULT_EMITTER_STREAM_ID, DEFAULT_PRINCIPAL_ID, type LedgerEventEnvelopeInput } from "../ledger/stable.js";
import type { ClockRuntime } from "./clock.js";
import { resolveClockState } from "./clock.js";
import type { ConditionEventMatch } from "./condition.js";
import { clampAndRound, type RangeSpec } from "./numeric.js";
import { runRuleActions } from "./rule-actions.js";
import { variableTargetFromActions, type CompiledTraceRuntime, type GeneratorRuntime, type RuleRuntime } from "./trace-compile.js";
import type { QueuedWorldAct, RuntimeTraceEvent, RuntimeVariableSample, WorldActResult } from "./types.js";
import { applyWorldActsAtTick } from "./world-act.js";

export type SimfileEventKind = "clock.sync" | "rule.fired" | "world.message" | "world.dm" | "world.act" | "wake.recommended" | "marker.seen";

export const WORLD_ACTOR = "@world";

/**
 * Shared canonical-envelope constructor for every event kind minted while
 * stepping a tick (and reused by `trace-run.ts` for its post-hoc
 * `marker.seen` events, so there is exactly one place that stamps the
 * causal envelope for simfile-native trace events).
 */
export const createTraceEvent = (
  runId: string,
  seq: number,
  kind: SimfileEventKind,
  simTime: number,
  actor: string,
  target: string,
  scope: string,
  payload: LedgerEventEnvelopeInput["payload"],
  causeEventIds: readonly string[] = []
): RuntimeTraceEvent => createCanonicalEventEnvelope({
  runId,
  seq,
  kind,
  simTime,
  provenance: "mechanical",
  actor,
  target,
  scope,
  payload,
  streamId: DEFAULT_EMITTER_STREAM_ID,
  principalId: DEFAULT_PRINCIPAL_ID,
  causeEventIds
}) as RuntimeTraceEvent;

const runGenerator = (
  generator: GeneratorRuntime,
  variables: Record<string, number>,
  tick: number,
  simTime: number,
  phase: string | undefined,
  candidates: readonly ConditionEventMatch[],
  runSeed: string
): void => {
  const active = generator.when ? generator.when.evaluator.evaluate(generator.when.node, {
    tick,
    simTime,
    phase,
    variables,
    eventsAtTick: candidates
  }) : true;
  if (!active) {
    return;
  }

  if (generator.mode === "set") {
    if (!generator.setExpr) {
      throw new Error(`generator ${generator.id} missing set expression`);
    }
    variables[generator.target] = generator.setExpr.evaluate({
      variables,
      tick,
      t: simTime
    });
    return;
  }

  if (generator.mode === "delta") {
    const delta = generator.deltaExpr
      ? generator.deltaExpr.evaluate({
        variables,
        tick,
        t: simTime
      })
      : generator.delta ?? 0;
    variables[generator.target] = (variables[generator.target] ?? 0) + delta;
    return;
  }

  const [min, max] = generator.uniform ?? [0, 0];
  const delta = drawUniform({
    runSeed,
    generatorId: generator.id,
    tick,
    drawIndex: 0,
    min,
    max
  });
  variables[generator.target] = (variables[generator.target] ?? 0) + delta;
};

const runRule = (
  rule: RuleRuntime,
  tick: number,
  simTime: number,
  phase: string | undefined,
  tickState: Readonly<Record<string, number>>,
  candidates: ConditionEventMatch[],
  precision: number,
  ranges: Map<string, RangeSpec>,
  runId: string,
  nextSeq: number,
  emitTickEvent: (event: RuntimeTraceEvent) => void,
  nextVariables: Record<string, number>,
  clockSyncEventId: string
): number => {
  const matches = rule.when.evaluator.evaluate(rule.when.node, {
    tick,
    simTime,
    phase,
    variables: tickState,
    eventsAtTick: candidates
  });

  const shouldFire = rule.fireMode === "once"
    ? matches && !rule.hasFired
    : matches && !rule.previousMatch;

  rule.previousMatch = matches;
  if (!shouldFire) {
    return nextSeq;
  }
  rule.hasFired = true;

  const target = variableTargetFromActions(rule.spec.do);
  const fired = createTraceEvent(runId, nextSeq, "rule.fired", simTime, rule.id, target, target, {
    rule: rule.id,
    tick,
    sim_time: simTime,
    phase
  }, [clockSyncEventId]);
  emitTickEvent(fired);
  candidates.push({ kind: fired.kind, actor: fired.actor, target: fired.target, scope: fired.scope });

  return runRuleActions(
    runId,
    nextSeq + 1,
    rule.id,
    tick,
    simTime,
    phase,
    rule.spec.do,
    tickState,
    precision,
    ranges,
    nextVariables,
    [fired.event_id],
    emitTickEvent
  );
};

export interface StepSimfileTickContext {
  runId: string;
  seed: string;
  precision: number;
  clock: ClockRuntime;
  runtime: CompiledTraceRuntime;
  /** Mutated in place: the run's variable state, before this tick on entry
   * and after this tick on return. */
  state: Record<string, number>;
  /** First seq number to mint for this tick's events. */
  seq: number;
  worldActsForTick?: readonly QueuedWorldAct[];
  worldActResultsByActId: ReadonlyMap<string, WorldActResult>;
}

export interface StepSimfileTickResult {
  events: RuntimeTraceEvent[];
  sample: RuntimeVariableSample;
  nextSeq: number;
}

/**
 * Advances the world by exactly one tick: resolve the clock, apply any
 * queued world.acts, run generators, recompute derived variables, evaluate
 * rules (minting their world-effect events), then fold the tick's ending
 * values back into `ctx.state`. This is the pure REFACTOR extraction of
 * `runSimfileTrace`'s former inline per-tick loop body — same inputs, same
 * outputs, same mutation order — so a live driver can call it once per
 * wall-clock tick instead of only ever inside one big batch loop.
 */
export const stepSimfileTick = (tick: number, ctx: StepSimfileTickContext): StepSimfileTickResult => {
  const { simTime, phase } = resolveClockState(ctx.clock, tick);
  const tickEvents: RuntimeTraceEvent[] = [];
  const candidates: ConditionEventMatch[] = [];
  const emitTickEvent = (event: RuntimeTraceEvent): void => {
    tickEvents.push(event);
    candidates.push({ kind: event.kind, actor: event.actor, target: event.target, scope: event.scope });
  };

  let seq = ctx.seq;
  const clockSync = createTraceEvent(ctx.runId, seq, "clock.sync", simTime, WORLD_ACTOR, "global", "global", {
    tick,
    sim_time: simTime,
    phase
  });
  emitTickEvent(clockSync);
  seq += 1;

  const tickState: Record<string, number> = { ...ctx.state };
  seq = applyWorldActsAtTick(tick, simTime, ctx.worldActsForTick, tickState, {
    runId: ctx.runId,
    precision: ctx.precision,
    ranges: ctx.runtime.ranges,
    variableScopes: ctx.runtime.variableScopes,
    resultsByActId: ctx.worldActResultsByActId,
    nextSeq: seq,
    emit: emitTickEvent
  });

  for (const generator of ctx.runtime.generators) {
    runGenerator(generator, tickState, tick, simTime, phase, candidates, ctx.seed);
    const range = ctx.runtime.ranges.get(generator.target);
    if (!range) {
      continue;
    }
    tickState[generator.target] = clampAndRound(tickState[generator.target] ?? 0, range, ctx.precision);
  }

  for (const variableId of ctx.runtime.derivedOrder) {
    const spec = ctx.runtime.derivedExpressions.get(variableId);
    const range = ctx.runtime.ranges.get(variableId);
    if (!spec || !range) {
      continue;
    }
    tickState[variableId] = clampAndRound(spec.expression.evaluate({
      variables: tickState,
      tick,
      t: simTime
    }), range, ctx.precision);
  }

  const nextVariables = { ...tickState };
  for (const rule of ctx.runtime.rules) {
    seq = runRule(rule, tick, simTime, phase, tickState, candidates, ctx.precision, ctx.runtime.ranges, ctx.runId, seq, emitTickEvent, nextVariables, clockSync.event_id);
  }

  for (const [id, value] of Object.entries(nextVariables)) {
    const range = ctx.runtime.ranges.get(id);
    if (!range) {
      continue;
    }
    ctx.state[id] = clampAndRound(value, range, ctx.precision);
  }

  return {
    events: tickEvents,
    sample: {
      phase,
      sim_time: simTime,
      tick,
      variables: { ...ctx.state }
    },
    nextSeq: seq
  };
};
