import { canonicalDynamicsJson } from "../dynamics/canonicalJson.js";
import { DYNAMICS_LIMITS } from "../dynamics/limits.js";
import type { ReadonlyDynamicsJsonValue } from "../dynamics/types.js";
import {
  cloneStableDynamicsJson,
  deepFreezeOwnData,
  defineOwnData,
  nullPrototypeRecord,
  ownDataValue
} from "./own-data.js";
import { validateBoundedJsonValue } from "./schema-value.js";
import {
  JSON_SCHEMA_2020_12,
  type BoundedArraySchema,
  type BoundedBooleanSchema,
  type BoundedJsonSchema,
  type BoundedJsonSchemaNode,
  type BoundedNullSchema,
  type BoundedNumberSchema,
  type BoundedObjectSchema,
  type BoundedStringSchema
} from "./types.js";

const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const COMMON_KEYWORDS = [
  "$schema",
  "const",
  "description",
  "enum",
  "title",
  "type"
] as const;
const TYPE_KEYWORDS = {
  array: ["items", "maxItems", "minItems"],
  boolean: [],
  integer: ["maximum", "minimum"],
  null: [],
  number: ["maximum", "minimum"],
  object: [
    "additionalProperties",
    "maxProperties",
    "minProperties",
    "properties",
    "required"
  ],
  string: ["maxLength", "minLength"]
} as const;

type SchemaType = keyof typeof TYPE_KEYWORDS;
type JsonRecord = Readonly<Record<string, ReadonlyDynamicsJsonValue>>;

const asObject = (value: unknown, path: string): JsonRecord => {
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    throw new TypeError(`${path} must be a JSON Schema object`);
  }
  return value as JsonRecord;
};

const requiredType = (record: JsonRecord, path: string): SchemaType => {
  const type = ownDataValue<ReadonlyDynamicsJsonValue>(record, "type");
  if (typeof type !== "string" || !Object.hasOwn(TYPE_KEYWORDS, type)) {
    throw new TypeError(`${path}.type must be one supported singular JSON type`);
  }
  return type as SchemaType;
};

const rejectUnsupportedKeywords = (
  record: JsonRecord,
  type: SchemaType,
  path: string,
  root: boolean
): void => {
  const allowed = new Set<string>([...COMMON_KEYWORDS, ...TYPE_KEYWORDS[type]]);
  for (const key of Object.keys(record)) {
    if (key === "$ref") {
      throw new TypeError(`${path} must not contain JSON Schema references`);
    }
    if (!allowed.has(key)) {
      throw new TypeError(`${path} contains unsupported JSON Schema keyword ${JSON.stringify(key)}`);
    }
    if (key === "$schema" && !root) {
      throw new TypeError(`${path} may not change the JSON Schema dialect`);
    }
  }
};

const optionalText = (
  record: JsonRecord,
  key: "description" | "title",
  path: string
): string | undefined => {
  const value = ownDataValue<ReadonlyDynamicsJsonValue>(record, key);
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new TypeError(`${path}.${key} must be a string`);
  return value;
};

const boundedCount = (
  value: ReadonlyDynamicsJsonValue | undefined,
  path: string,
  required: boolean,
  ceiling: number = DYNAMICS_LIMITS.json_nodes
): number | undefined => {
  if (value === undefined) {
    if (required) throw new TypeError(`${path} is required to bound this schema`);
    return undefined;
  }
  if (!Number.isSafeInteger(value) || (value as number) < 0
    || (value as number) > ceiling) {
    throw new TypeError(`${path} must be a non-negative safe integer within DYNAMICS_LIMITS`);
  }
  return value as number;
};

const finiteNumber = (
  value: ReadonlyDynamicsJsonValue | undefined,
  path: string
): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError(`${path} must be a finite number`);
  }
  return value;
};

const parseCommon = (
  record: JsonRecord,
  path: string,
  root: boolean
): {
  readonly $schema?: typeof JSON_SCHEMA_2020_12;
  readonly const?: ReadonlyDynamicsJsonValue;
  readonly description?: string;
  readonly enum?: readonly ReadonlyDynamicsJsonValue[];
  readonly title?: string;
} => {
  const dialect = ownDataValue<ReadonlyDynamicsJsonValue>(record, "$schema");
  const constant = ownDataValue<ReadonlyDynamicsJsonValue>(record, "const");
  const enumValue = ownDataValue<ReadonlyDynamicsJsonValue>(record, "enum");
  const description = optionalText(record, "description", path);
  const title = optionalText(record, "title", path);
  if (dialect !== undefined) {
    if (!root || dialect !== JSON_SCHEMA_2020_12) {
      throw new TypeError(`${path} supports only the JSON Schema 2020-12 dialect`);
    }
  }
  let enumeration: readonly ReadonlyDynamicsJsonValue[] | undefined;
  if (enumValue !== undefined) {
    if (!Array.isArray(enumValue) || enumValue.length === 0) {
      throw new TypeError(`${path}.enum must be a non-empty array`);
    }
    const identities = enumValue.map((value) => canonicalDynamicsJson(value));
    if (new Set(identities).size !== identities.length) {
      throw new TypeError(`${path}.enum values must be unique`);
    }
    enumeration = enumValue;
  }
  return {
    ...(dialect === undefined ? {} : { $schema: JSON_SCHEMA_2020_12 }),
    ...(constant === undefined ? {} : { const: constant }),
    ...(description === undefined ? {} : { description }),
    ...(enumeration === undefined ? {} : { enum: enumeration }),
    ...(title === undefined ? {} : { title })
  };
};

const parseSchema = (
  value: ReadonlyDynamicsJsonValue,
  path: string,
  root: boolean
): BoundedJsonSchemaNode => {
  const record = asObject(value, path);
  if (Object.hasOwn(record, "$ref")) {
    throw new TypeError(`${path} must not contain JSON Schema references`);
  }
  const type = requiredType(record, path);
  rejectUnsupportedKeywords(record, type, path, root);
  const common = parseCommon(record, path, root);
  let schema: BoundedJsonSchemaNode;

  if (type === "null") {
    schema = { ...common, type } satisfies BoundedNullSchema;
  } else if (type === "boolean") {
    schema = { ...common, type } satisfies BoundedBooleanSchema;
  } else if (type === "number" || type === "integer") {
    const minimum = finiteNumber(
      ownDataValue(record, "minimum"),
      `${path}.minimum`
    );
    const maximum = finiteNumber(
      ownDataValue(record, "maximum"),
      `${path}.maximum`
    );
    if (minimum > maximum) throw new TypeError(`${path}.minimum must not exceed maximum`);
    if (type === "integer" && Math.ceil(minimum) > Math.floor(maximum)) {
      throw new TypeError(`${path} integer bounds must contain at least one integer`);
    }
    schema = { ...common, maximum, minimum, type } satisfies BoundedNumberSchema;
  } else if (type === "string") {
    const minLength = boundedCount(
      ownDataValue(record, "minLength"),
      `${path}.minLength`,
      false,
      DYNAMICS_LIMITS.json_string_length
    );
    const maxLength = boundedCount(
      ownDataValue(record, "maxLength"),
      `${path}.maxLength`,
      true,
      DYNAMICS_LIMITS.json_string_length
    )!;
    if (maxLength > DYNAMICS_LIMITS.json_string_length) {
      throw new TypeError(`${path}.maxLength exceeds DYNAMICS_LIMITS.json_string_length`);
    }
    if (minLength !== undefined && minLength > maxLength) {
      throw new TypeError(`${path}.minLength must not exceed maxLength`);
    }
    schema = {
      ...common,
      maxLength,
      ...(minLength === undefined ? {} : { minLength }),
      type
    } satisfies BoundedStringSchema;
  } else if (type === "array") {
    const items = ownDataValue<ReadonlyDynamicsJsonValue>(record, "items");
    if (items === undefined) throw new TypeError(`${path}.items is required`);
    const minItems = boundedCount(
      ownDataValue(record, "minItems"),
      `${path}.minItems`,
      false
    );
    const maxItems = boundedCount(
      ownDataValue(record, "maxItems"),
      `${path}.maxItems`,
      true
    )!;
    if (minItems !== undefined && minItems > maxItems) {
      throw new TypeError(`${path}.minItems must not exceed maxItems`);
    }
    schema = {
      ...common,
      items: parseSchema(items, `${path}.items`, false),
      maxItems,
      ...(minItems === undefined ? {} : { minItems }),
      type
    } satisfies BoundedArraySchema;
  } else {
    const properties = asObject(
      ownDataValue<ReadonlyDynamicsJsonValue>(record, "properties"),
      `${path}.properties`
    );
    if (ownDataValue(record, "additionalProperties") !== false) {
      throw new TypeError(`${path}.additionalProperties must be false`);
    }
    const parsedProperties = nullPrototypeRecord<BoundedJsonSchemaNode>([]);
    for (const [key, child] of Object.entries(properties)) {
      defineOwnData(
        parsedProperties,
        key,
        parseSchema(child, `${path}.properties.${key}`, false)
      );
    }
    const required = parseRequired(
      ownDataValue(record, "required"),
      parsedProperties,
      `${path}.required`
    );
    const minProperties = boundedCount(
      ownDataValue(record, "minProperties"),
      `${path}.minProperties`,
      false
    );
    const maxProperties = boundedCount(
      ownDataValue(record, "maxProperties"),
      `${path}.maxProperties`,
      false
    );
    const propertyCount = Object.keys(parsedProperties).length;
    if (maxProperties !== undefined && maxProperties > propertyCount) {
      throw new TypeError(`${path}.maxProperties exceeds its closed property count`);
    }
    const effectiveMaximum = maxProperties ?? propertyCount;
    if (minProperties !== undefined && minProperties > effectiveMaximum) {
      throw new TypeError(`${path}.minProperties exceeds its closed property bound`);
    }
    if (required !== undefined && required.length > effectiveMaximum) {
      throw new TypeError(`${path}.required exceeds maxProperties`);
    }
    schema = {
      ...common,
      additionalProperties: false,
      ...(maxProperties === undefined ? {} : { maxProperties }),
      ...(minProperties === undefined ? {} : { minProperties }),
      properties: parsedProperties,
      ...(required === undefined ? {} : { required }),
      type
    } satisfies BoundedObjectSchema;
  }

  validateSchemaConstants(schema, path);
  return schema;
};

const parseRequired = (
  value: ReadonlyDynamicsJsonValue | undefined,
  properties: Readonly<Record<string, BoundedJsonSchemaNode>>,
  path: string
): readonly string[] | undefined => {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new TypeError(`${path} must be an array of property names`);
  }
  const names = value as string[];
  if (new Set(names).size !== names.length) throw new TypeError(`${path} must be unique`);
  for (const name of names) {
    if (UNSAFE_KEYS.has(name)) throw new TypeError(`${path} contains an unsafe property name`);
    if (!Object.hasOwn(properties, name)) {
      throw new TypeError(`${path} names undeclared property ${JSON.stringify(name)}`);
    }
  }
  return names;
};

const validateSchemaConstants = (schema: BoundedJsonSchemaNode, path: string): void => {
  const constant = ownDataValue<ReadonlyDynamicsJsonValue>(schema, "const");
  const enumeration =
    ownDataValue<readonly ReadonlyDynamicsJsonValue[]>(schema, "enum");
  if (constant !== undefined) {
    validateBoundedJsonValue(schema, constant, `${path}.const`, false);
  }
  for (const [index, value] of (enumeration ?? []).entries()) {
    validateBoundedJsonValue(schema, value, `${path}.enum[${index}]`, false);
  }
  if (constant !== undefined && enumeration !== undefined) {
    const identity = canonicalDynamicsJson(constant);
    if (!enumeration.some((value) => canonicalDynamicsJson(value) === identity)) {
      throw new TypeError(`${path}.const must be present in enum`);
    }
  }
};

export const parseBoundedJsonSchema = (input: unknown): BoundedJsonSchema => {
  const parsed = parseSchema(
    cloneStableDynamicsJson(input, "schema"),
    "schema",
    true
  );
  return deepFreezeOwnData(
    cloneStableDynamicsJson(parsed, "checked schema")
  ) as unknown as BoundedJsonSchema;
};

export const parseBoundedJsonValue = (
  schema: BoundedJsonSchema,
  input: unknown,
  path = "value"
): ReadonlyDynamicsJsonValue => {
  const checkedSchema = parseBoundedJsonSchema(schema);
  const value = cloneStableDynamicsJson(input, path);
  validateBoundedJsonValue(checkedSchema, value, path);
  return deepFreezeOwnData(value);
};
