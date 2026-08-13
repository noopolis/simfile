import { DYNAMICS_LIMITS } from "./limits.js";
import type { DynamicsJsonObject, DynamicsJsonValue } from "./types.js";

const DANGEROUS_KEYS = new Set(["__proto__", "constructor", "prototype"]);

interface JsonBudget {
  codeUnits: number;
  nodes: number;
}

const consumeString = (value: string, path: string, budget: JsonBudget): string => {
  if (value.length > DYNAMICS_LIMITS.json_string_length) {
    throw new Error(`${path} exceeds the dynamics JSON string limit`);
  }
  budget.codeUnits += value.length;
  if (budget.codeUnits > DYNAMICS_LIMITS.json_code_units) {
    throw new Error(`${path} exceeds the cumulative dynamics JSON code-unit limit`);
  }
  return value;
};

const consumeNode = (budget: JsonBudget, depth: number, path: string): void => {
  if (depth > DYNAMICS_LIMITS.json_depth) {
    throw new Error(`${path} exceeds the dynamics JSON depth limit`);
  }
  budget.nodes += 1;
  if (budget.nodes > DYNAMICS_LIMITS.json_nodes) {
    throw new Error(`${path} exceeds the dynamics JSON node limit`);
  }
};

const cloneArray = (
  value: unknown[],
  path: string,
  depth: number,
  budget: JsonBudget
): DynamicsJsonValue[] => {
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.some((key) =>
    typeof key !== "string"
    || (key !== "length" && (!/^(?:0|[1-9][0-9]*)$/u.test(key) || Number(key) >= value.length)))) {
    throw new Error(`${path} must not contain non-index array properties`);
  }
  const cloned: DynamicsJsonValue[] = [];
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) throw new Error(`${path} must not contain sparse arrays`);
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor?.enumerable || !("value" in descriptor)) {
      throw new Error(`${path}[${index}] must be an enumerable data value`);
    }
    cloned.push(cloneValue(descriptor.value, `${path}[${index}]`, depth + 1, budget));
  }
  return cloned;
};

const cloneObject = (
  value: object,
  path: string,
  depth: number,
  budget: JsonBudget
): DynamicsJsonObject => {
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${path} must contain only plain JSON objects`);
  }
  const entries: Array<[string, DynamicsJsonValue]> = [];
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") throw new Error(`${path} must not contain symbol keys`);
    consumeString(key, `${path} key`, budget);
    if (DANGEROUS_KEYS.has(key)) throw new Error(`${path}.${key} is not a safe dynamics JSON key`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !("value" in descriptor)) {
      throw new Error(`${path}.${key} must be an enumerable data value`);
    }
    entries.push([key, cloneValue(descriptor.value, `${path}.${key}`, depth + 1, budget)]);
  }
  entries.sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
  return Object.fromEntries(entries);
};

const cloneValue = (
  value: unknown,
  path: string,
  depth: number,
  budget: JsonBudget
): DynamicsJsonValue => {
  consumeNode(budget, depth, path);
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") return consumeString(value, path, budget);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`${path} must contain only finite numbers`);
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) return cloneArray(value, path, depth, budget);
  if (typeof value === "object") return cloneObject(value, path, depth, budget);
  throw new Error(`${path} must be JSON-compatible`);
};

export const cloneDynamicsJson = (value: unknown, path = "value"): DynamicsJsonValue =>
  cloneValue(value, path, 0, { codeUnits: 0, nodes: 0 });

export const cloneDynamicsJsonObject = (value: unknown, path = "value"): DynamicsJsonObject => {
  const cloned = cloneDynamicsJson(value, path);
  if (cloned === null || Array.isArray(cloned) || typeof cloned !== "object") {
    throw new Error(`${path} must be an object`);
  }
  return cloned;
};

/** Injective for every accepted dynamics JSON value after the documented -0 normalization. */
export const canonicalDynamicsJson = (value: unknown, path = "value"): string =>
  JSON.stringify(cloneDynamicsJson(value, path));
