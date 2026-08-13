import { canonicalDynamicsJson } from "../dynamics/canonicalJson.js";
import type { ReadonlyDynamicsJsonValue } from "../dynamics/types.js";
import { ownDataValue } from "./own-data.js";
import {
  WorldSurfaceActionInputRejection,
  type WorldActIngressRejectionReason,
} from "./rejection.js";
import type {
  BoundedJsonSchemaNode
} from "./types.js";

type JsonRecord = Readonly<Record<string, ReadonlyDynamicsJsonValue>>;

const reject = (
  message: string,
  reason: WorldActIngressRejectionReason,
  fieldPath?: string,
): never => {
  throw new WorldSurfaceActionInputRejection(message, reason, fieldPath);
};

const propertyPath = (parent: string | undefined, property: string): string =>
  parent === undefined ? property : `${parent}.${property}`;
const indexPath = (parent: string | undefined, index: number): string | undefined =>
  parent === undefined ? undefined : `${parent}[${index}]`;

const asObject = (
  value: ReadonlyDynamicsJsonValue,
  path: string,
  fieldPath: string | undefined,
): JsonRecord => {
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    return reject(`${path} must be a JSON Schema object`, "action_input_wrong_type", fieldPath);
  }
  return value as JsonRecord;
};

export const validateBoundedJsonValue = (
  schema: BoundedJsonSchemaNode,
  value: ReadonlyDynamicsJsonValue,
  path: string,
  checkConstants = true,
  fieldPath?: string,
): void => {
  if (schema.type === "null" && value !== null) {
    return reject(`${path} must be null`, "action_input_wrong_type", fieldPath);
  }
  if (schema.type === "boolean" && typeof value !== "boolean") {
    return reject(`${path} must be a boolean`, "action_input_wrong_type", fieldPath);
  }
  if ((schema.type === "number" || schema.type === "integer")
    && (typeof value !== "number" || (schema.type === "integer" && !Number.isInteger(value)))) {
    return reject(`${path} must be a ${schema.type}`, "action_input_wrong_type", fieldPath);
  }
  if (schema.type === "number" || schema.type === "integer") {
    if ((value as number) < schema.minimum || (value as number) > schema.maximum) {
      return reject(`${path} is outside the declared numeric bounds`, "action_input_out_of_bounds", fieldPath);
    }
  } else if (schema.type === "string") {
    if (typeof value !== "string") {
      return reject(`${path} must be a string`, "action_input_wrong_type", fieldPath);
    }
    const minLength = ownDataValue<number>(schema, "minLength") ?? 0;
    if (value.length < minLength || value.length > schema.maxLength) {
      return reject(`${path} is outside the declared string bounds`, "action_input_out_of_bounds", fieldPath);
    }
  } else if (schema.type === "array") {
    if (!Array.isArray(value)) {
      return reject(`${path} must be an array`, "action_input_wrong_type", fieldPath);
    }
    const minItems = ownDataValue<number>(schema, "minItems") ?? 0;
    if (value.length < minItems || value.length > schema.maxItems) {
      return reject(`${path} is outside the declared array bounds`, "action_input_out_of_bounds", fieldPath);
    }
    value.forEach((entry, index) =>
      validateBoundedJsonValue(
        schema.items,
        entry,
        `${path}[${index}]`,
        true,
        indexPath(fieldPath, index),
      ));
  } else if (schema.type === "object") {
    const record = asObject(value, path, fieldPath);
    const keys = Object.keys(record);
    const minProperties = ownDataValue<number>(schema, "minProperties") ?? 0;
    const maxProperties = ownDataValue<number>(schema, "maxProperties")
      ?? Object.keys(schema.properties).length;
    // Preserve the original first-failure contract: object bounds deliberately
    // precede required-field and unknown-property validation.
    if (keys.length < minProperties || keys.length > maxProperties) {
      return reject(`${path} is outside the declared object bounds`, "action_input_out_of_bounds", fieldPath);
    }
    const required = ownDataValue<readonly string[]>(schema, "required") ?? [];
    for (const key of required) {
      if (!Object.hasOwn(record, key)) {
        return reject(
          `${path}.${key} is required`,
          "action_input_missing_field",
          propertyPath(fieldPath, key),
        );
      }
    }
    const schemaKeys = Object.keys(schema.properties);
    for (const recordKey of keys) {
      const schemaKey = schemaKeys.find((key) => key === recordKey);
      if (schemaKey === undefined) {
        return reject(
          `${path}.${recordKey} is not an allowed property`,
          "action_input_unknown_field",
        );
      }
      validateBoundedJsonValue(
        ownDataValue<BoundedJsonSchemaNode>(schema.properties, schemaKey)!,
        ownDataValue<ReadonlyDynamicsJsonValue>(record, recordKey)!,
        `${path}.${schemaKey}`,
        true,
        propertyPath(fieldPath, schemaKey),
      );
    }
  }

  if (!checkConstants) return;
  const identity = canonicalDynamicsJson(value);
  const constant = ownDataValue<ReadonlyDynamicsJsonValue>(schema, "const");
  if (constant !== undefined && canonicalDynamicsJson(constant) !== identity) {
    return reject(`${path} does not equal the schema const`, "action_input_not_allowed_value", fieldPath);
  }
  const enumeration = ownDataValue<readonly ReadonlyDynamicsJsonValue[]>(schema, "enum");
  if (enumeration !== undefined
    && !enumeration.some((entry) => canonicalDynamicsJson(entry) === identity)) {
    return reject(`${path} is not one of the schema enum values`, "action_input_not_allowed_value", fieldPath);
  }
};
