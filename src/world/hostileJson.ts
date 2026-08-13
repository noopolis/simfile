import { types } from "node:util";

import { DYNAMICS_LIMITS } from "../dynamics/limits.js";

type HostileJsonPrimitive = null | boolean | number | string;
interface HostileJsonObject { readonly [key: string]: HostileJson; }
export type HostileJson = HostileJsonPrimitive | readonly HostileJson[] | Readonly<HostileJsonObject>;

interface Budget {
  codeUnits: number;
  nodes: number;
}

const DANGEROUS_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const INDEX = /^(?:0|[1-9][0-9]*)$/u;

const fail = (): never => { throw new TypeError("hostile JSON rejected"); };
const frozen = <Value>(value: Value): Value => Object.freeze(value);
const isProxy = (value: object): boolean => types.isProxy(value);

const addNode = (budget: Budget, depth: number): void => {
  if (depth > DYNAMICS_LIMITS.json_depth || ++budget.nodes > DYNAMICS_LIMITS.json_nodes) fail();
};

const addText = (value: string, budget: Budget): void => {
  if (value.length > DYNAMICS_LIMITS.json_string_length) fail();
  budget.codeUnits += value.length;
  if (budget.codeUnits > DYNAMICS_LIMITS.json_code_units) fail();
};

/** Scans descriptors only, including the prototype chain, after proxy rejection. */
const hasThen = (value: object): boolean => {
  let current: object | null = value;
  while (current !== null) {
    if (isProxy(current) || Object.getOwnPropertyDescriptor(current, "then") !== undefined) return true;
    current = Object.getPrototypeOf(current);
  }
  return false;
};

const arrayLength = (value: unknown[]): number => {
  const descriptor = Object.getOwnPropertyDescriptor(value, "length");
  if (descriptor === undefined || !("value" in descriptor)) fail();
  const length = (descriptor as PropertyDescriptor & { value: unknown }).value;
  if (!Number.isSafeInteger(length) || length < 0 || length > DYNAMICS_LIMITS.json_nodes) fail();
  return length;
};

const copyArray = (value: unknown[], seen: Set<object>, depth: number, budget: Budget): HostileJson => {
  if (Object.getPrototypeOf(value) !== Array.prototype || hasThen(value)) fail();
  const length = arrayLength(value);
  const keys = Reflect.ownKeys(value);
  if (keys.length !== length + 1 || !keys.includes("length") || keys.some((key) =>
    typeof key !== "string" || (key !== "length" && (!INDEX.test(key) || Number(key) >= length)))) fail();
  const copy: HostileJson[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) fail();
    copy.push(copyValue((descriptor as PropertyDescriptor & { value: unknown }).value, seen, depth + 1, budget));
  }
  return frozen(copy);
};

const copyObject = (value: object, seen: Set<object>, depth: number, budget: Budget): HostileJson => {
  const prototype = Object.getPrototypeOf(value);
  if ((prototype !== Object.prototype && prototype !== null) || hasThen(value)) fail();
  const entries: Array<readonly [string, HostileJson]> = [];
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") fail();
    const textKey = key as string;
    if (DANGEROUS_KEYS.has(textKey)) fail();
    addText(textKey, budget);
    const descriptor = Object.getOwnPropertyDescriptor(value, textKey);
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) fail();
    entries.push([textKey, copyValue((descriptor as PropertyDescriptor & { value: unknown }).value, seen, depth + 1, budget)]);
  }
  entries.sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
  const copy = Object.create(null) as Record<string, HostileJson>;
  for (const [key, child] of entries) Object.defineProperty(copy, key, {
    configurable: false, enumerable: true, value: child, writable: false,
  });
  return frozen(copy);
};

const copyValue = (value: unknown, seen: Set<object>, depth: number, budget: Budget): HostileJson => {
  addNode(budget, depth);
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") { addText(value, budget); return value; }
  if (typeof value === "number") return Number.isFinite(value) ? (Object.is(value, -0) ? 0 : value) : fail();
  if (typeof value !== "object" || value === null) fail();
  const source = value as object;
  if (isProxy(source) || seen.has(source)) fail();
  seen.add(source);
  return Array.isArray(source) ? copyArray(source, seen, depth, budget) : copyObject(source, seen, depth, budget);
};

/**
 * Copies an untrusted JSON graph without evaluating user code. The visited set
 * is deliberately never unwound: repeated aliases and cycles are both invalid.
 */
export const copyHostileJson = (input: unknown): HostileJson =>
  copyValue(input, new Set<object>(), 0, { codeUnits: 0, nodes: 0 });
