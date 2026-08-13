import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type {
  DynamicsProviderObservation,
  WorldSurfaceDefinition as DynamicsExportedWorldSurfaceDefinition
} from "../dynamics/index.js";
import { DYNAMICS_LIMITS } from "../dynamics/limits.js";
import {
  JSON_SCHEMA_2020_12,
  parseBoundedJsonSchema,
  parseBoundedJsonValue,
  WORLD_SURFACE_API_VERSION,
  type BoundedJsonSchema,
  type BoundedJsonSchemaNode,
  type WorldSenseProjectionInput,
  type WorldSurfaceDefinition
} from "./index.js";

type TypeEqual<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends
  (<Value>() => Value extends Right ? 1 : 2) ? true : false;
type NestedNodeHasDialect = "$schema" extends keyof BoundedJsonSchemaNode ? true : false;
const nestedNodeHasDialect: NestedNodeHasDialect = false;
type CallbackObservation = WorldSenseProjectionInput["observation"];
type CallbackChannel = CallbackObservation["channels"][number];
const readonlyObservationProof: [
  TypeEqual<CallbackObservation, DynamicsProviderObservation>,
  CallbackObservation["channels"] extends unknown[] ? true : false,
  TypeEqual<CallbackObservation, Readonly<CallbackObservation>>,
  TypeEqual<CallbackChannel, Readonly<CallbackChannel>>,
  TypeEqual<CallbackChannel["components"], Readonly<Record<string, number>>>
] = [false, false, true, true, true];

const rootDialectSchema = {
  $schema: JSON_SCHEMA_2020_12,
  type: "null"
} as const satisfies BoundedJsonSchema;

const emptyObjectSchema = {
  additionalProperties: false,
  properties: {},
  type: "object"
} as const;

const worldSurface = {
  api_version: WORLD_SURFACE_API_VERSION,
  entities: {
    marker: { address: "entity:marker", dynamics_address: "object:marker" },
    observer: { address: "entity:observer", dynamics_address: "object:observer" }
  },
  senses: {
    "sense:local-state": {
      dynamics_senses: ["sense:world.state"],
      output: "simfile.numeric-observation.v1",
      project: () => ({ channels: [] })
    }
  },
  affordances: {
    "affordance:adjust": {
      available: () => true,
      dynamics_action: "adjust",
      input_schema: emptyObjectSchema,
      lower: () => ({}),
      rejection_codes: ["unavailable"],
      target_selector: { kind: "fixed", targets: ["entity:marker"] }
    }
  },
  effects: {
    "effect:marker-adjusted": {
      dynamics_event: "world.marker_adjusted",
      payload_schema: emptyObjectSchema
    }
  }
} as const satisfies WorldSurfaceDefinition;
const exportedWorldSurface: DynamicsExportedWorldSurfaceDefinition = worldSurface;

const boundedActionSchema = () => ({
  $schema: JSON_SCHEMA_2020_12,
  additionalProperties: false,
  maxProperties: 3,
  properties: {
    direction: {
      enum: ["left", "right"],
      maxLength: 5,
      type: "string"
    },
    force: {
      maximum: 1,
      minimum: 0,
      type: "number"
    },
    samples: {
      items: {
        maximum: 10,
        minimum: -10,
        type: "integer"
      },
      maxItems: 4,
      type: "array"
    }
  },
  required: ["direction", "force"],
  type: "object"
});

describe("bounded JSON Schema 2020-12 subset", () => {
  it("exposes ergonomic world-surface authoring literals with a root dialect", () => {
    assert.equal(rootDialectSchema.$schema, JSON_SCHEMA_2020_12);
    assert.equal(nestedNodeHasDialect, false);
    assert.deepEqual(readonlyObservationProof, [false, false, true, true, true]);
    assert.equal(exportedWorldSurface.entities.marker.address, "entity:marker");
    assert.equal(
      worldSurface.affordances["affordance:adjust"].target_selector.targets[0],
      "entity:marker"
    );
  });

  it("accepts, clones, and freezes a closed bounded schema", () => {
    const input = boundedActionSchema();
    const schema = parseBoundedJsonSchema(input);

    assert.notEqual(schema, input);
    assert.equal(schema.$schema, JSON_SCHEMA_2020_12);
    assert.equal(Object.isFrozen(schema), true);
    assert.equal(Object.isFrozen((schema as { properties: object }).properties), true);
    assert.deepEqual(JSON.parse(JSON.stringify(schema)), input);
  });

  it("validates and freezes values with numeric, string, array, object, and enum bounds", () => {
    const schema = parseBoundedJsonSchema(boundedActionSchema());
    const source = { direction: "left", force: 0.5, samples: [-1, 2] };
    const value = parseBoundedJsonValue(schema, source);

    assert.deepEqual(JSON.parse(JSON.stringify(value)), source);
    assert.notEqual(value, source);
    assert.equal(Object.isFrozen(value), true);
    assert.equal(Object.isFrozen((value as { samples: object }).samples), true);

    for (const invalid of [
      { direction: "up", force: 0.5 },
      { direction: "left" },
      { direction: "left", force: 2 },
      { direction: "left", force: 0.5, samples: [1, 2, 3, 4, 5] },
      { direction: "left", force: 0.5, extra: true }
    ]) {
      assert.throws(() => parseBoundedJsonValue(schema, invalid), /enum|required|bounds|allowed/u);
    }
  });

  it("supports bounded const, boolean, and null leaves", () => {
    const schema = parseBoundedJsonSchema({
      additionalProperties: false,
      properties: {
        enabled: { const: true, type: "boolean" },
        marker: { type: "null" }
      },
      required: ["enabled", "marker"],
      type: "object"
    });
    assert.deepEqual(
      JSON.parse(JSON.stringify(parseBoundedJsonValue(schema, { enabled: true, marker: null }))),
      { enabled: true, marker: null }
    );
    assert.throws(
      () => parseBoundedJsonValue(schema, { enabled: false, marker: null }),
      /schema const/u
    );
  });

  it("accepts the normative maximum string bound above the node ceiling", () => {
    const schema = parseBoundedJsonSchema({
      maxLength: DYNAMICS_LIMITS.json_string_length,
      type: "string"
    });
    assert.equal(schema.type, "string");
    assert.equal(schema.maxLength, DYNAMICS_LIMITS.json_string_length);
  });

  it("rejects every reference and unsupported or behavioral keyword", () => {
    for (const keyword of [
      { $ref: "https://example.test/schema" },
      { $ref: "#/$defs/local" },
      { $defs: {} },
      { default: 0 },
      { format: "uri" },
      { pattern: ".*" },
      { examples: [0] },
      { oneOf: [{ type: "null" }] }
    ]) {
      assert.throws(
        () => parseBoundedJsonSchema({
          maximum: 1,
          minimum: 0,
          type: "number",
          ...keyword
        }),
        /references|unsupported JSON Schema keyword/u
      );
    }
    assert.throws(
      () => parseBoundedJsonSchema({
        additionalProperties: false,
        properties: {
          nested: {
            $schema: JSON_SCHEMA_2020_12,
            type: "null"
          }
        },
        type: "object"
      }),
      /may not change.*dialect/u
    );
  });

  it("rejects unbounded scalar, array, and object declarations", () => {
    for (const schema of [
      { maximum: 1, type: "number" },
      { minimum: 0, type: "integer" },
      { type: "string" },
      { items: { type: "null" }, type: "array" },
      { maxItems: 1, type: "array" },
      { additionalProperties: true, properties: {}, type: "object" },
      { additionalProperties: false, type: "object" }
    ]) {
      assert.throws(
        () => parseBoundedJsonSchema(schema),
        /required|finite number|additionalProperties|properties/u
      );
    }
  });

  it("rejects contradictory, non-finite, and excessive declared bounds", () => {
    for (const schema of [
      { maximum: Infinity, minimum: 0, type: "number" },
      { maximum: 0, minimum: 1, type: "number" },
      {
        maxLength: DYNAMICS_LIMITS.json_string_length + 1,
        type: "string"
      },
      { maxItems: DYNAMICS_LIMITS.json_nodes + 1, type: "array", items: { type: "null" } },
      {
        additionalProperties: false,
        maxProperties: DYNAMICS_LIMITS.json_nodes + 1,
        properties: {},
        type: "object"
      },
      {
        additionalProperties: false,
        maxProperties: 2,
        properties: { only: { type: "null" } },
        type: "object"
      },
      { maxLength: 1, minLength: 2, type: "string" },
      { maxItems: 1, minItems: 2, type: "array", items: { type: "null" } }
    ]) {
      assert.throws(
        () => parseBoundedJsonSchema(schema),
        /finite|exceed|within DYNAMICS_LIMITS|must not exceed/u
      );
    }
    assert.throws(
      () => parseBoundedJsonSchema({
        maximum: 0.2, minimum: 0.1, type: "integer"
      }),
      /integer bounds must contain at least one integer/u
    );
  });

  it("rejects unsafe keys, undeclared required names, and duplicate enum values", () => {
    const unsafeProperties = JSON.parse(
      '{"type":"object","properties":{"__proto__":{"type":"null"}},"additionalProperties":false}'
    );
    assert.throws(() => parseBoundedJsonSchema(unsafeProperties), /safe dynamics JSON key/u);
    assert.throws(
      () => parseBoundedJsonSchema({
        additionalProperties: false,
        maxProperties: 0,
        properties: { needed: { type: "null" } },
        required: ["needed"],
        type: "object"
      }),
      /required exceeds maxProperties/u
    );
    assert.throws(
      () => parseBoundedJsonSchema({
        additionalProperties: false,
        minProperties: 2,
        properties: { only: { type: "null" } },
        type: "object"
      }),
      /minProperties exceeds/u
    );
    assert.throws(
      () => parseBoundedJsonSchema({
        additionalProperties: false,
        maxProperties: 0,
        minProperties: 1,
        properties: { only: { type: "null" } },
        type: "object"
      }),
      /minProperties exceeds/u
    );
    assert.throws(
      () => parseBoundedJsonSchema({
        additionalProperties: false,
        properties: {},
        required: ["constructor"],
        type: "object"
      }),
      /unsafe property name/u
    );
    assert.throws(
      () => parseBoundedJsonSchema({
        additionalProperties: false,
        properties: {},
        required: ["missing"],
        type: "object"
      }),
      /undeclared property/u
    );
    assert.throws(
      () => parseBoundedJsonSchema({
        enum: ["same", "same"],
        maxLength: 4,
        type: "string"
      }),
      /enum values must be unique/u
    );
  });

  it("enforces schema depth, node, string, and cumulative code-unit limits", () => {
    let deep: unknown = { type: "null" };
    for (let index = 0; index <= DYNAMICS_LIMITS.json_depth; index += 1) {
      deep = { items: deep, maxItems: 1, type: "array" };
    }
    assert.throws(() => parseBoundedJsonSchema(deep), /depth limit/u);

    const manyProperties = Object.fromEntries(
      Array.from(
        { length: DYNAMICS_LIMITS.json_nodes + 1 },
        (_, index) => [`p${index}`, { type: "null" }]
      )
    );
    assert.throws(
      () => parseBoundedJsonSchema({
        additionalProperties: false,
        properties: manyProperties,
        type: "object"
      }),
      /node limit/u
    );
    assert.throws(
      () => parseBoundedJsonSchema({
        description: "x".repeat(DYNAMICS_LIMITS.json_string_length + 1),
        type: "null"
      }),
      /string limit/u
    );
    const cumulative = Object.fromEntries(
      Array.from(
        { length: Math.floor(DYNAMICS_LIMITS.json_code_units / 1_000) + 1 },
        (_, index) => [
          `p${index}`,
          { description: "x".repeat(1_000), type: "null" }
        ]
      )
    );
    assert.throws(
      () => parseBoundedJsonSchema({
        additionalProperties: false,
        properties: cumulative,
        type: "object"
      }),
      /code-unit limit/u
    );
  });

  it("rejects hostile schema and value shapes before reading accessors", () => {
    const accessor = Object.defineProperty({}, "type", {
      enumerable: true,
      get: () => { throw new Error("ACCESSOR_RAN"); }
    });
    assert.throws(
      () => parseBoundedJsonSchema(accessor),
      /enumerable data value/u
    );

    const schema = parseBoundedJsonSchema({
      items: { type: "null" },
      maxItems: 2,
      type: "array"
    });
    const sparse: unknown[] = [];
    sparse[1] = null;
    assert.throws(() => parseBoundedJsonValue(schema, sparse), /sparse arrays/u);
  });
});
