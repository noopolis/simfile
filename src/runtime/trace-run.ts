import { drawUniform } from "../kernel/stochastic.js";
import { createCanonicalEventEnvelope, type LedgerEventEnvelopeInput } from "../ledger/stable.js";
import { scanMarkers } from "../ledger/markers.js";
import type { Simfile, SimfileRuleAction } from "../schema/model.js";
import { parseClockSpec, resolveClockState } from "./clock.js";
import type { RuntimeOptions, RuntimeTrace, RuntimeTraceEvent, RuntimeVariableSample } from "./types.js";
import { compileRuntime, variableTargetFromActions, type GeneratorRuntime, type RuleRuntime } from "./trace-compile.js";
import type { ConditionEventMatch } from "./condition.js";

type EventKind = "clock.sync" | "rule.fired" | "world.message" | "world.dm" | "wake.recommended" | "marker.seen";

interface RangeSpec { min: number; max: number }

const DEFAULT_PRECISION = 6;
const EVENT_FUSE_LIMIT = 5_000;
const WORLD_ACTOR = "@world";

const finite = (value: number): number => (Number.isFinite(value) ? value : 0);

const clampAndRound = (value: number, range: RangeSpec, precision: number): number => {
  const rounded = Number(finite(value).toFixed(precision));
  if (rounded < range.min) {
    return range.min;
  }
  if (rounded > range.max) {
    return range.max;
  }
  return rounded === -0 ? 0 : rounded;
};

const validateNonNegativeInteger = (value: number, name: string): void => {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
};

const replaceTemplateValues = (
  source: string,
  variables: Readonly<Record<string, number>>,
  precision: number
): string => source.replace(
  /\{([a-z][a-z0-9_-]*)\}/giu,
  (match, variableId) => {
    const value = variables[variableId as string];
    return Number.isFinite(value) ? value.toFixed(precision) : match;
  }
);

const createEvent = (
  runId: string,
  seq: number,
  kind: EventKind,
  simTime: number,
  actor: string,
  target: string,
  scope: string,
  payload: LedgerEventEnvelopeInput["payload"]
): RuntimeTraceEvent => createCanonicalEventEnvelope({
  runId,
  seq,
  kind,
  simTime,
  provenance: "mechanical",
  actor,
  target,
  scope,
  payload
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

const emitRuleActionEvents = (
  runId: string,
  seq: number,
  ruleId: string,
  tick: number,
  simTime: number,
  phase: string | undefined,
  action: SimfileRuleAction,
  templateVariables: Readonly<Record<string, number>>,
  precision: number,
  emit: (event: RuntimeTraceEvent) => void
): number => {
  if (action.action === "variable:set" || action.action === "variable:delta") {
    return seq;
  }

  if (action.action === "moltnet:message") {
    emit(createEvent(runId, seq, "world.message", simTime, WORLD_ACTOR, action.to, action.to, {
      action: action.action,
      rule: ruleId,
      content: replaceTemplateValues(action.content, templateVariables, precision),
      tick,
      sim_time: simTime,
      phase
    }));
    return seq + 1;
  }

  if (action.action === "moltnet:dm") {
    emit(createEvent(runId, seq, "world.dm", simTime, WORLD_ACTOR, action.to, action.to, {
      action: action.action,
      rule: ruleId,
      content: replaceTemplateValues(action.content, templateVariables, precision),
      tick,
      sim_time: simTime,
      phase
    }));
    return seq + 1;
  }

  emit(createEvent(runId, seq, "wake.recommended", simTime, ruleId, action.to, action.to, {
    action: action.action,
    reason: ruleId,
    target: action.to,
    tick,
    sim_time: simTime,
    phase
  }));
  return seq + 1;
};

const runRuleActions = (
  runId: string,
  seq: number,
  ruleId: string,
  tick: number,
  simTime: number,
  phase: string | undefined,
  actions: readonly SimfileRuleAction[],
  templateVariables: Readonly<Record<string, number>>,
  precision: number,
  ranges: Map<string, RangeSpec>,
  nextVariables: Record<string, number>,
  emit: (event: RuntimeTraceEvent) => void
): number => {
  let nextSeq = seq;
  for (const action of actions) {
    if (action.action === "variable:set") {
      const range = ranges.get(action.variable);
      if (!range) {
        throw new Error(`action variable:set references unknown variable ${action.variable}`);
      }
      nextVariables[action.variable] = clampAndRound(action.value, range, precision);
      continue;
    }

    if (action.action === "variable:delta") {
      const range = ranges.get(action.variable);
      if (!range) {
        throw new Error(`action variable:delta references unknown variable ${action.variable}`);
      }
      nextVariables[action.variable] = clampAndRound((nextVariables[action.variable] ?? 0) + action.value, range, precision);
      continue;
    }

    nextSeq = emitRuleActionEvents(
      runId,
      nextSeq,
      ruleId,
      tick,
      simTime,
      phase,
      action,
      templateVariables,
      precision,
      emit
    );
  }
  return nextSeq;
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
  nextVariables: Record<string, number>
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
  const fired = createEvent(runId, nextSeq, "rule.fired", simTime, rule.id, target, target, {
    rule: rule.id,
    tick,
    sim_time: simTime,
    phase
  });
  emitTickEvent(fired);
  candidates.push({ kind: fired.kind, actor: fired.actor, target: fired.target, scope: fired.scope });

  const afterActionSeq = runRuleActions(
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
    emitTickEvent
  );
  return afterActionSeq;
};

export const runSimfileTrace = (simfile: Simfile, options: RuntimeOptions): RuntimeTrace => {
  const precision = Math.max(0, Math.floor(options.precision ?? DEFAULT_PRECISION));
  validateNonNegativeInteger(precision, "precision");
  validateNonNegativeInteger(options.ticks, "ticks");

  const clock = parseClockSpec(simfile.clock);
  const runtime = compileRuntime(simfile);
  const state: Record<string, number> = {};
  for (const [id, value] of Object.entries(runtime.initialState)) {
    const range = runtime.ranges.get(id);
    if (!range) {
      throw new Error(`variable ${id} missing range`);
    }
    state[id] = clampAndRound(value, range, precision);
  }

  const events: RuntimeTraceEvent[] = [];
  const samples: RuntimeVariableSample[] = [];
  let seq = 1;
  const emitEvent = (event: RuntimeTraceEvent): void => {
    events.push(event);
    if (events.length > options.ticks * EVENT_FUSE_LIMIT) {
      throw new Error(`event fuse tripped at ${events.length} events`);
    }
  };

  for (let tick = 0; tick < options.ticks; tick += 1) {
    const { simTime, phase } = resolveClockState(clock, tick);
    const tickEvents: RuntimeTraceEvent[] = [];
    const candidates: ConditionEventMatch[] = [];
    const emitTickEvent = (event: RuntimeTraceEvent): void => {
      tickEvents.push(event);
      candidates.push({ kind: event.kind, actor: event.actor, target: event.target, scope: event.scope });
    };

    emitTickEvent(createEvent(options.runId, seq, "clock.sync", simTime, WORLD_ACTOR, "global", "global", {
      tick,
      sim_time: simTime,
      phase
    }));
    seq += 1;

    const tickState: Record<string, number> = { ...state };
    for (const generator of runtime.generators) {
      runGenerator(generator, tickState, tick, simTime, phase, candidates, options.seed);
      const range = runtime.ranges.get(generator.target);
      if (!range) {
        continue;
      }
      tickState[generator.target] = clampAndRound(tickState[generator.target] ?? 0, range, precision);
    }

    for (const variableId of runtime.derivedOrder) {
      const spec = runtime.derivedExpressions.get(variableId);
      const range = runtime.ranges.get(variableId);
      if (!spec || !range) {
        continue;
      }
      tickState[variableId] = clampAndRound(spec.expression.evaluate({
        variables: tickState,
        tick,
        t: simTime
      }), range, precision);
    }

    const nextVariables = { ...tickState };
    for (const rule of runtime.rules) {
      seq = runRule(rule, tick, simTime, phase, tickState, candidates, precision, runtime.ranges, options.runId, seq, emitTickEvent, nextVariables);
    }

    for (const [id, value] of Object.entries(nextVariables)) {
      const range = runtime.ranges.get(id);
      if (!range) {
        continue;
      }
      state[id] = clampAndRound(value, range, precision);
    }

    samples.push({
      phase,
      sim_time: simTime,
      tick,
      variables: { ...state }
    });

    for (const event of tickEvents) {
      emitEvent(event);
    }
  }

  for (const [markerId, hits] of Object.entries(scanMarkers(events, simfile.markers))) {
    for (const hit of hits) {
      emitEvent(createEvent(options.runId, seq, "marker.seen", hit.simTime, markerId, hit.scope, hit.scope, {
        alias: hit.alias,
        marker: markerId,
        source_event_id: hit.eventId,
        source_event_kind: hit.eventKind
      }));
      seq += 1;
    }
  }

  return {
    runId: options.runId,
    seed: options.seed,
    ticks: options.ticks,
    variables: state,
    events,
    samples,
    diagnostics: []
  };
};
