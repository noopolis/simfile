import { cloneDynamicsJson } from "../dynamics/canonicalJson.js";
import type {
  DynamicsJsonObject,
  DynamicsJsonValue
} from "../dynamics/types.js";

export const ownDataValue = <Value = unknown>(
  record: object,
  key: string
): Value | undefined => {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  return descriptor && "value" in descriptor
    ? descriptor.value as Value
    : undefined;
};

export const defineOwnData = (
  record: object,
  key: string,
  value: unknown
): void => {
  Object.defineProperty(record, key, {
    configurable: true,
    enumerable: true,
    value,
    writable: true
  });
};

export const nullPrototypeRecord = <Value>(
  entries: Iterable<readonly [string, Value]>
): Record<string, Value> => {
  const record = Object.create(null) as Record<string, Value>;
  for (const [key, value] of entries) defineOwnData(record, key, value);
  return record;
};

const stabilizeJson = (value: DynamicsJsonValue): DynamicsJsonValue => {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(stabilizeJson);
  return nullPrototypeRecord(
    Object.entries(value).map(([key, child]) =>
      [key, stabilizeJson(child)] as const)
  ) as DynamicsJsonObject;
};

export const cloneStableDynamicsJson = (
  input: unknown,
  path = "value"
): DynamicsJsonValue => stabilizeJson(cloneDynamicsJson(input, path));

export const cloneStableDynamicsJsonObject = (
  input: unknown,
  path = "value"
): DynamicsJsonObject => {
  const value = cloneStableDynamicsJson(input, path);
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    throw new TypeError(`${path} must be an object`);
  }
  return value;
};

export const deepFreezeOwnData = <Value>(value: Value): Value => {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreezeOwnData(child);
    Object.freeze(value);
  }
  return value;
};
