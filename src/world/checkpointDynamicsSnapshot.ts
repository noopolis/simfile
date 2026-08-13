import { types } from "node:util";
import { cloneDynamicsJson } from "../dynamics/canonicalJson.js";
import { DYNAMICS_ACTION_RETENTION_LIMITS, DYNAMICS_LIMITS } from "../dynamics/limits.js";
import { parseDynamicsSessionSnapshot } from "../dynamics/snapshotValidation.js";
import type { DynamicsJsonValue, DynamicsSessionSnapshot } from "../dynamics/types.js";

const dangerous = new Set(["__proto__", "constructor", "prototype"]);
const index = /^(?:0|[1-9][0-9]*)$/u;
const record = (value: unknown): Record<string, unknown> | undefined => {
  if (value === null || typeof value !== "object" || Array.isArray(value) || types.isProxy(value as object)) return undefined;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return undefined;
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== "string" || dangerous.has(key))) return undefined;
  const output: Record<string, unknown> = Object.create(null);
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !("value" in descriptor)) return undefined;
    output[key as string] = descriptor.value;
  }
  return output;
};
const array = (value: unknown, maximum: number): readonly unknown[] | undefined => {
  if (!Array.isArray(value) || types.isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype) return undefined;
  const length = Object.getOwnPropertyDescriptor(value, "length");
  if (!length || !("value" in length) || !Number.isSafeInteger(length.value) || length.value < 0 || length.value > maximum) return undefined;
  const keys = Reflect.ownKeys(value);
  if (keys.length !== length.value + 1 || keys.some((key) => typeof key !== "string" || (key !== "length" && (!index.test(key) || Number(key) >= length.value)))) return undefined;
  const output: unknown[] = [];
  for (let offset = 0; offset < length.value; offset += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(offset));
    if (!descriptor?.enumerable || !("value" in descriptor)) return undefined;
    output.push(descriptor.value);
  }
  return output;
};
const copyJson = (value: unknown, seen: Set<object>): DynamicsJsonValue | undefined => {
  if (value === null || typeof value !== "object") return typeof value === "function" || typeof value === "symbol" || typeof value === "undefined" ? undefined : value as DynamicsJsonValue;
  if (types.isProxy(value) || seen.has(value as object)) return undefined;
  seen.add(value as object);
  const values = Array.isArray(value) ? array(value, DYNAMICS_LIMITS.retained_action_records) : undefined;
  if (values !== undefined) {
    const output = values.map((entry) => copyJson(entry, seen));
    if (output.some((entry) => entry === undefined)) return undefined;
    return output as DynamicsJsonValue[];
  }
  const source = record(value);
  if (source === undefined) return undefined;
  const output: Record<string, DynamicsJsonValue> = Object.create(null);
  for (const [key, child] of Object.entries(source)) {
    const copied = copyJson(child, seen);
    if (copied === undefined) return undefined;
    output[key] = copied;
  }
  return output;
};
const copySection = (value: unknown, maximum: number): unknown[] | undefined => {
  const values = array(value, maximum);
  if (values === undefined) return undefined;
  const seen = new Set<object>();
  const output = values.map((entry) => copyJson(entry, seen));
  return output.some((entry) => entry === undefined) ? undefined : output;
};

export const copyCheckpointDynamicsSnapshot = (input: unknown): DynamicsSessionSnapshot | undefined => {
  try {
    const source = record(input);
    if (source === undefined || source.version !== "simfile.dynamics-snapshot.v1") return undefined;
    const accepted = copyJson(source.accepted_action_sequences, new Set<object>());
    const ingress = copySection(source.action_ingress, DYNAMICS_ACTION_RETENTION_LIMITS.records);
    const pending = copySection(source.pending_actions, DYNAMICS_LIMITS.actions_per_tick);
    const resolved = copyJson(source.resolved_action_sequences, new Set<object>());
    const provider = cloneDynamicsJson(copyJson(source.provider_state, new Set<object>()), "checkpoint dynamics provider_state");
    if (accepted === undefined || ingress === undefined || pending === undefined || resolved === undefined) return undefined;
    const copy = { ...source, accepted_action_sequences: accepted, action_ingress: ingress, pending_actions: pending, resolved_action_sequences: resolved, provider_state: provider };
    return Object.freeze(parseDynamicsSessionSnapshot(copy));
  } catch { return undefined; }
};
