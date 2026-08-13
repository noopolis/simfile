import { types } from "node:util";

import { compareUtf16, deepFreeze } from "../dynamics/buildIdentity.js";

const dangerous = new Set(["__proto__", "constructor", "prototype"]);

const fail = (label: string): never => { throw new TypeError(`world artifact ${label} is unsafe`); };

export const exactData = (value: unknown, keys: readonly string[], label: string): Record<string, unknown> => {
  if (value === null || typeof value !== "object" || Array.isArray(value) || types.isProxy(value as object)
    || Object.getPrototypeOf(value) !== Object.prototype) fail(label);
  const object = value as object;
  const found = Reflect.ownKeys(object);
  if (found.length !== keys.length || found.some((key) => typeof key !== "string" || !keys.includes(key) || dangerous.has(key))) fail(label);
  const copied: Record<string, unknown> = {};
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(object, key);
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) fail(label);
    copied[key] = (descriptor as PropertyDescriptor & { value: unknown }).value;
  }
  return copied;
};

export const exactArray = (value: unknown, maximum: number, label: string): readonly unknown[] => {
  if (!Array.isArray(value) || types.isProxy(value as object) || Object.getPrototypeOf(value) !== Array.prototype) fail(label);
  const array = value as unknown[];
  const length = Object.getOwnPropertyDescriptor(array, "length");
  if (length === undefined || !("value" in length) || !Number.isSafeInteger(length.value) || length.value > maximum
    || Reflect.ownKeys(array).length !== length.value + 1) fail(label);
  const arrayLength = (length as PropertyDescriptor & { value: number }).value;
  const copied: unknown[] = [];
  for (let index = 0; index < arrayLength; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(array, String(index));
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) fail(label);
    copied.push((descriptor as PropertyDescriptor & { value: unknown }).value);
  }
  return copied;
};

export const boundedText = (value: unknown, maximum: number, label: string): string => {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum) fail(label);
  return value as string;
};

export const boundedInteger = (value: unknown, minimum: number, maximum: number, label: string): number => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || Object.is(value, -0) || value < minimum || value > maximum) fail(label);
  return value as number;
};

export const sortedUniqueText = (value: unknown, maximum: number, itemMaximum: number, label: string): readonly string[] => {
  const array = exactArray(value, maximum, label);
  const output = array.map((item, index) => boundedText(item, itemMaximum, `${label}[${index}]`));
  if (output.some((item, index) => index > 0 && compareUtf16(output[index - 1] as string, item) >= 0)) fail(label);
  return deepFreeze(output) as readonly string[];
};

export const uniqueText = (value: unknown, maximum: number, itemMaximum: number, label: string): readonly string[] => {
  const array = exactArray(value, maximum, label);
  const output = array.map((item, index) => boundedText(item, itemMaximum, `${label}[${index}]`));
  if (new Set(output).size !== output.length) fail(label);
  return deepFreeze(output) as readonly string[];
};

export const frozen = <T>(value: T): T => deepFreeze(value) as T;

/** Copies one bounded ordinary-data graph before an authority parser inspects it. */
export const snapshotDataGraph = (value: unknown, label: string, maximumNodes = 8192): unknown => {
  const seen = new WeakSet<object>(); let nodes = 0;
  const visit = (item: unknown, path: string, depth: number): unknown => {
    if (++nodes > maximumNodes || depth > 32) fail(path);
    if (item === null || typeof item === "boolean") return item;
    if (typeof item === "string") return boundedText(item, 16 * 1024, path);
    if (typeof item === "number") {
      if (!Number.isSafeInteger(item) || Object.is(item, -0)) fail(path);
      return item;
    }
    if (item === null || typeof item !== "object" || types.isProxy(item as object) || seen.has(item as object)) fail(path);
    seen.add(item as object);
    if (Array.isArray(item)) {
      const values = exactArray(item, maximumNodes, path);
      return values.map((child, index) => visit(child, `${path}[${index}]`, depth + 1));
    }
    if (Object.getPrototypeOf(item) !== Object.prototype) fail(path);
    const output: Record<string, unknown> = {};
    const object = item as object;
    for (const key of Reflect.ownKeys(object)) {
      if (typeof key !== "string" || dangerous.has(key)) fail(path);
      const stringKey = key as string;
      const descriptor = Object.getOwnPropertyDescriptor(object, stringKey);
      if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) fail(path);
      output[stringKey] = visit((descriptor as PropertyDescriptor & { value: unknown }).value, `${path}.${stringKey}`, depth + 1);
    }
    return output;
  };
  return visit(value, label, 0);
};
