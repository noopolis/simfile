import { createCanonicalEventEnvelope, DEFAULT_EMITTER_STREAM_ID, DEFAULT_PRINCIPAL_ID } from "../ledger/stable.js";
import type { SimfileRuleAction } from "../schema/model.js";
import { clampAndRound, type RangeSpec } from "./numeric.js";
import type { RuntimeTraceEvent } from "./types.js";

const WORLD_ACTOR = "@world";

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

/** Unique, deterministic identifier for a single world act (rule-emitted action). */
const actId = (runId: string, seq: number): string => `${runId}:act:${seq}`;

const createActionEvent = (
  runId: string,
  seq: number,
  kind: "world.message" | "world.dm" | "wake.recommended",
  simTime: number,
  actor: string,
  target: string,
  scope: string,
  payload: Record<string, unknown>,
  causeEventIds: readonly string[]
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

/**
 * world.act payload minimum: {sim_time, provenance, actor, target, scope,
 * act_id, action, value}. Rule-emitted world events (world.message, world.dm,
 * wake.recommended) are simfile's world.act variants, so every one of these
 * carries the minimum keys directly in payload alongside its existing fields.
 */
const worldActPayload = (
  fields: {
    simTime: number;
    actor: string;
    target: string;
    scope: string;
    seq: number;
    runId: string;
    action: string;
    value: unknown;
  },
  extra: Record<string, unknown>
): Record<string, unknown> => ({
  sim_time: fields.simTime,
  provenance: "mechanical",
  actor: fields.actor,
  target: fields.target,
  scope: fields.scope,
  act_id: actId(fields.runId, fields.seq),
  action: fields.action,
  value: fields.value,
  ...extra
});

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
  causeEventIds: readonly string[],
  emit: (event: RuntimeTraceEvent) => void
): number => {
  if (action.action === "variable:set" || action.action === "variable:delta") {
    return seq;
  }

  if (action.action === "moltnet:message") {
    const content = replaceTemplateValues(action.content, templateVariables, precision);
    emit(createActionEvent(runId, seq, "world.message", simTime, WORLD_ACTOR, action.to, action.to, worldActPayload(
      { simTime, actor: WORLD_ACTOR, target: action.to, scope: action.to, seq, runId, action: action.action, value: content },
      { rule: ruleId, content, tick, phase }
    ), causeEventIds));
    return seq + 1;
  }

  if (action.action === "moltnet:dm") {
    const content = replaceTemplateValues(action.content, templateVariables, precision);
    emit(createActionEvent(runId, seq, "world.dm", simTime, WORLD_ACTOR, action.to, action.to, worldActPayload(
      { simTime, actor: WORLD_ACTOR, target: action.to, scope: action.to, seq, runId, action: action.action, value: content },
      { rule: ruleId, content, tick, phase }
    ), causeEventIds));
    return seq + 1;
  }

  emit(createActionEvent(runId, seq, "wake.recommended", simTime, ruleId, action.to, action.to, worldActPayload(
    { simTime, actor: ruleId, target: action.to, scope: action.to, seq, runId, action: action.action, value: null },
    { reason: ruleId, target: action.to, tick, phase }
  ), causeEventIds));
  return seq + 1;
};

export const runRuleActions = (
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
  causeEventIds: readonly string[],
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
      causeEventIds,
      emit
    );
  }
  return nextSeq;
};
