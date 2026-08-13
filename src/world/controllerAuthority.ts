import { isDeepStrictEqual, types } from "node:util";

import { DYNAMICS_LIMITS } from "../dynamics/limits.js";
import type { DynamicsSession } from "../dynamics/session.js";
import type {
  DynamicsActionQueueReceipt,
  DynamicsJsonObject,
  DynamicsStepResult,
} from "../dynamics/types.js";

export interface WorldControllerAction {
  readonly action: string;
  readonly actor: string;
  readonly controller_id: string;
  readonly controller_version: string;
  readonly input: DynamicsJsonObject;
  readonly intent_id?: string;
  readonly policy: "default" | "intent";
  readonly skill: string;
  readonly target: string;
}

export interface WorldControllerRecord extends WorldControllerAction {
  readonly accepted?: boolean;
  readonly act_id: string;
  readonly apply_tick: number;
  readonly code?: string;
  readonly event_kinds: readonly string[];
  readonly sequence?: number;
  readonly status: "queued" | "applied" | "rejected";
}

export interface WorldRuntimeControllerAuthority {
  inspect(): readonly WorldControllerRecord[];
  queue(action: WorldControllerAction): DynamicsActionQueueReceipt;
  settle(step: DynamicsStepResult): DynamicsStepResult;
}

type RuntimeOperation = {
  enter(): void;
  leave(): void;
  close(): void;
};

const authorities = new WeakMap<object, WorldRuntimeControllerAuthority>();
const issued = new WeakSet<object>();

const text = (value: unknown, maximum = 256): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= maximum
  && value === value.trim();

const plainInput = (value: unknown): value is DynamicsJsonObject =>
  value !== null && typeof value === "object" && !Array.isArray(value)
  && !types.isProxy(value as object)
  && Object.getPrototypeOf(value) === Object.prototype;

const parseAction = (value: WorldControllerAction): WorldControllerAction => {
  if (value === null || typeof value !== "object" || types.isProxy(value)
    || Object.getPrototypeOf(value) !== Object.prototype
    || !text(value.action) || !text(value.actor) || !text(value.controller_id)
    || !text(value.controller_version) || !text(value.skill)
    || !text(value.target) || !plainInput(value.input)
    || value.policy !== "default" && value.policy !== "intent"
    || value.intent_id !== undefined && !text(value.intent_id)) {
    throw new TypeError("invalid world controller action");
  }
  return structuredClone(value);
};

const cloneRecord = (record: WorldControllerRecord): WorldControllerRecord =>
  Object.freeze(structuredClone(record));

export const readWorldRuntimeControllerAuthority = (
  runtime: unknown,
): WorldRuntimeControllerAuthority | undefined =>
  runtime !== null && typeof runtime === "object" ? authorities.get(runtime) : undefined;

/** @internal Issues one host-only controller lane for a composed world runtime. */
export const createWorldRuntimeControllerAuthority = (
  runtime: object,
  dependencies: Readonly<{
    dynamics: DynamicsSession;
    operation: RuntimeOperation;
  }>,
): WorldRuntimeControllerAuthority => {
  if (authorities.has(runtime)) throw new Error("world controller authority already issued");
  const records: WorldControllerRecord[] = [];
  const pending = new Map<number, number>();
  const queue = (raw: WorldControllerAction): DynamicsActionQueueReceipt => {
    const action = parseAction(raw);
    dependencies.operation.enter();
    try {
      const applyTick = dependencies.dynamics.nextTick;
      const actId = `controller:${action.controller_id}:${applyTick}`;
      const existing = records.find((record) => record.act_id === actId);
      if (existing !== undefined) {
        const priorAction = {
          action: existing.action,
          actor: existing.actor,
          controller_id: existing.controller_id,
          controller_version: existing.controller_version,
          input: existing.input,
          ...(existing.intent_id === undefined ? {} : { intent_id: existing.intent_id }),
          policy: existing.policy,
          skill: existing.skill,
          target: existing.target,
        };
        if (!isDeepStrictEqual(action, priorAction)) {
          throw new Error("world controller action id conflict");
        }
        return Object.freeze({ act_id: existing.act_id, apply_tick: existing.apply_tick,
          queued: existing.status === "queued", ...(existing.sequence === undefined ? {} : { sequence: existing.sequence }),
          ...(existing.code === undefined ? {} : { code: existing.code as DynamicsActionQueueReceipt["code"] }) });
      }
      if (records.length >= DYNAMICS_LIMITS.retained_action_records) {
        throw new Error("world controller record capacity reached");
      }
      const receipt = dependencies.dynamics.queueAction({
        act_id: actId,
        action: action.action,
        actor: action.actor,
        at_tick: applyTick,
        input: action.input,
        origin: "controller",
        principal_id: `controller:${action.controller_id}`,
        target: action.target,
      });
      const index = records.length;
      records.push(Object.freeze({
        ...action,
        act_id: actId,
        apply_tick: receipt.apply_tick,
        event_kinds: Object.freeze([]),
        ...(receipt.sequence === undefined ? {} : { sequence: receipt.sequence }),
        status: receipt.queued ? "queued" : "rejected",
        ...(receipt.code === undefined ? {} : { code: receipt.code }),
      }));
      if (receipt.queued && receipt.sequence !== undefined) {
        pending.set(receipt.sequence, index);
      }
      return Object.freeze({ ...receipt });
    } finally {
      dependencies.operation.leave();
    }
  };
  const settle = (step: DynamicsStepResult): DynamicsStepResult => {
    const controllerSequences = new Set<number>();
    for (const result of step.action_results) {
      const index = pending.get(result.sequence);
      if (index === undefined) continue;
      const record = records[index]!;
      if (result.origin !== "controller"
        || result.principal_id !== `controller:${record.controller_id}`
        || result.act_id !== record.act_id || result.action !== record.action
        || result.actor !== record.actor || result.target !== record.target
        || result.apply_tick !== record.apply_tick) {
        dependencies.operation.close();
        throw new Error("world controller mechanics result mismatch");
      }
      const eventKinds = step.events
        .filter((event) => event.cause_action_sequences.includes(result.sequence))
        .map((event) => event.kind);
      records[index] = Object.freeze({
        ...record,
        accepted: result.accepted,
        ...(result.code === undefined ? {} : { code: result.code }),
        event_kinds: Object.freeze(eventKinds),
        status: result.accepted ? "applied" : "rejected",
      });
      pending.delete(result.sequence);
      controllerSequences.add(result.sequence);
    }
    const missing = [...pending.entries()].find(([, index]) =>
      records[index]?.apply_tick === step.tick);
    if (missing !== undefined) {
      dependencies.operation.close();
      throw new Error("world controller mechanics result missing");
    }
    return Object.freeze({
      tick: step.tick,
      action_results: step.action_results.filter((result) =>
        !controllerSequences.has(result.sequence)),
      ...(step.commitment_outcomes === undefined ? {} : {
        commitment_outcomes: step.commitment_outcomes,
      }),
      events: step.events.flatMap((event) => {
        const agentCauses = event.cause_action_sequences.filter((sequence) =>
          !controllerSequences.has(sequence));
        return agentCauses.length === 0 ? [] : [Object.freeze({
          ...event,
          cause_action_sequences: agentCauses,
        })];
      }),
    });
  };
  const authority: WorldRuntimeControllerAuthority = Object.freeze({
    inspect: () => Object.freeze(records.map(cloneRecord)),
    queue,
    settle,
  });
  issued.add(authority);
  authorities.set(runtime, authority);
  return authority;
};

export const isWorldRuntimeControllerAuthority = (
  value: unknown,
): value is WorldRuntimeControllerAuthority =>
  value !== null && typeof value === "object" && issued.has(value);
