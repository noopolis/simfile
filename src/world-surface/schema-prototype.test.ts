import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  parseBoundedJsonSchema,
  parseBoundedJsonValue,
  type BoundedObjectJsonSchema
} from "./index.js";

interface KeywordCase {
  readonly inherited: unknown;
  readonly input: unknown;
  readonly keyword: string;
  readonly validWithoutOwnKeyword: boolean;
}

const keywordCases: readonly KeywordCase[] = [
  { inherited: "null", input: {}, keyword: "type", validWithoutOwnKeyword: false },
  { inherited: "wrong", input: { type: "null" }, keyword: "$schema", validWithoutOwnKeyword: true },
  { inherited: null, input: { type: "null" }, keyword: "const", validWithoutOwnKeyword: true },
  { inherited: [null], input: { type: "null" }, keyword: "enum", validWithoutOwnKeyword: true },
  { inherited: "text", input: { type: "null" }, keyword: "description", validWithoutOwnKeyword: true },
  { inherited: "text", input: { type: "null" }, keyword: "title", validWithoutOwnKeyword: true },
  {
    inherited: 0,
    input: { maximum: 1, type: "number" },
    keyword: "minimum",
    validWithoutOwnKeyword: false
  },
  {
    inherited: 1,
    input: { minimum: 0, type: "number" },
    keyword: "maximum",
    validWithoutOwnKeyword: false
  },
  {
    inherited: 1,
    input: { maxLength: 2, type: "string" },
    keyword: "minLength",
    validWithoutOwnKeyword: true
  },
  {
    inherited: 2,
    input: { type: "string" },
    keyword: "maxLength",
    validWithoutOwnKeyword: false
  },
  {
    inherited: { type: "null" },
    input: { maxItems: 1, type: "array" },
    keyword: "items",
    validWithoutOwnKeyword: false
  },
  {
    inherited: 1,
    input: { items: { type: "null" }, maxItems: 2, type: "array" },
    keyword: "minItems",
    validWithoutOwnKeyword: true
  },
  {
    inherited: 2,
    input: { items: { type: "null" }, type: "array" },
    keyword: "maxItems",
    validWithoutOwnKeyword: false
  },
  {
    inherited: {},
    input: { additionalProperties: false, type: "object" },
    keyword: "properties",
    validWithoutOwnKeyword: false
  },
  {
    inherited: false,
    input: { properties: {}, type: "object" },
    keyword: "additionalProperties",
    validWithoutOwnKeyword: false
  },
  {
    inherited: [],
    input: { additionalProperties: false, properties: {}, type: "object" },
    keyword: "required",
    validWithoutOwnKeyword: true
  },
  {
    inherited: 1,
    input: { additionalProperties: false, properties: {}, type: "object" },
    keyword: "minProperties",
    validWithoutOwnKeyword: true
  },
  {
    inherited: 0,
    input: { additionalProperties: false, properties: {}, type: "object" },
    keyword: "maxProperties",
    validWithoutOwnKeyword: true
  }
];

const installGetter = (
  key: string,
  value: unknown
): { readonly reads: () => number; readonly restore: () => void } => {
  const original = Object.getOwnPropertyDescriptor(Object.prototype, key);
  let readCount = 0;
  Object.defineProperty(Object.prototype, key, {
    configurable: true,
    get: () => {
      readCount += 1;
      return value;
    }
  });
  return {
    reads: () => readCount,
    restore: () => {
      if (original) Object.defineProperty(Object.prototype, key, original);
      else delete (Object.prototype as Record<string, unknown>)[key];
    }
  };
};

describe("bounded schema prototype isolation", () => {
  it("own-reads every required and optional schema keyword", () => {
    for (const testCase of keywordCases) {
      const getter = installGetter(testCase.keyword, testCase.inherited);
      let error: unknown;
      let parsed: unknown;
      try {
        try {
          parsed = parseBoundedJsonSchema(testCase.input);
        } catch (caught) {
          error = caught;
        }
      } finally {
        getter.restore();
      }
      assert.equal(getter.reads(), 0, testCase.keyword);
      if (testCase.validWithoutOwnKeyword) {
        assert.equal(error, undefined, testCase.keyword);
        assert.ok(parsed, testCase.keyword);
        assert.equal(Object.hasOwn(parsed as object, testCase.keyword), false);
      } else {
        assert.ok(error instanceof TypeError, testCase.keyword);
      }
    }
  });

  it("returns stable schemas, consts, enums, and checked JSON maps", () => {
    const schema = parseBoundedJsonSchema({
      additionalProperties: false,
      const: { value: 1 },
      enum: [{ value: 1 }],
      properties: {
        value: { maximum: 2, minimum: 0, type: "number" }
      },
      required: ["value"],
      type: "object"
    }) as BoundedObjectJsonSchema;
    const constant = schema.const as Readonly<Record<string, unknown>>;
    const enumerated = schema.enum![0] as Readonly<Record<string, unknown>>;
    const value = parseBoundedJsonValue(schema, { value: 1 }) as
      Readonly<Record<string, unknown>>;

    assert.equal(Object.getPrototypeOf(schema), null);
    assert.equal(Object.getPrototypeOf(schema.properties), null);
    assert.equal(Object.getPrototypeOf(schema.properties.value), null);
    assert.equal(Object.getPrototypeOf(constant), null);
    assert.equal(Object.getPrototypeOf(enumerated), null);
    assert.equal(Object.getPrototypeOf(value), null);
    assert.equal(Object.isFrozen(value), true);

    const original = Object.getOwnPropertyDescriptor(Object.prototype, "observer");
    Object.defineProperty(Object.prototype, "observer", {
      configurable: true,
      value: "poison"
    });
    try {
      assert.equal(
        (schema as unknown as Readonly<Record<string, unknown>>).observer,
        undefined
      );
      assert.equal(constant.observer, undefined);
      assert.equal(enumerated.observer, undefined);
      assert.equal(value.observer, undefined);
      assert.doesNotThrow(() => parseBoundedJsonValue(schema, { value: 1 }));
    } finally {
      if (original) Object.defineProperty(Object.prototype, "observer", original);
      else delete (Object.prototype as { observer?: unknown }).observer;
    }
  });

  it("ignores inherited optional validator constraints after parsing", () => {
    const cases: ReadonlyArray<readonly [string, unknown, unknown, unknown]> = [
      ["const", { type: "null" }, null, true],
      ["enum", { type: "null" }, null, [true]],
      ["minLength", { maxLength: 2, type: "string" }, "", 1],
      [
        "minItems",
        { items: { type: "null" }, maxItems: 2, type: "array" },
        [],
        1
      ],
      [
        "minProperties",
        { additionalProperties: false, properties: {}, type: "object" },
        {},
        1
      ],
      [
        "maxProperties",
        {
          additionalProperties: false,
          properties: {
            allowed: { maximum: 2, minimum: 0, type: "number" }
          },
          type: "object"
        },
        { allowed: 1 },
        0
      ],
      [
        "required",
        { additionalProperties: false, properties: {}, type: "object" },
        {},
        ["missing"]
      ]
    ];
    for (const [keyword, input, value, inherited] of cases) {
      const schema = parseBoundedJsonSchema(input);
      const getter = installGetter(keyword, inherited);
      let error: unknown;
      try {
        try {
          parseBoundedJsonValue(schema, value);
        } catch (caught) {
          error = caught;
        }
      } finally {
        getter.restore();
      }
      assert.equal(getter.reads(), 0, keyword);
      assert.equal(error, undefined, keyword);
    }
  });

  it("rejects built-in property names unless explicitly declared", () => {
    const empty = parseBoundedJsonSchema({
      additionalProperties: false,
      properties: {},
      type: "object"
    });
    const declaredOnly = parseBoundedJsonSchema({
      additionalProperties: false,
      properties: {
        allowed: { maximum: 2, minimum: 0, type: "number" }
      },
      type: "object"
    });
    for (const key of ["toString", "hasOwnProperty", "valueOf"]) {
      assert.throws(
        () => parseBoundedJsonValue(empty, { [key]: 1 }),
        /bounds|allowed/u
      );
      assert.throws(
        () => parseBoundedJsonValue(declaredOnly, { [key]: 1 }),
        /allowed/u
      );
    }

    const builtIn = parseBoundedJsonSchema({
      additionalProperties: false,
      properties: {
        toString: { maximum: 2, minimum: 0, type: "number" }
      },
      required: ["toString"],
      type: "object"
    });
    const value = parseBoundedJsonValue(builtIn, { toString: 1 }) as
      Readonly<Record<string, unknown>>;
    assert.equal(value.toString, 1);
    assert.equal(Object.getPrototypeOf(value), null);
  });

  it("does not invoke inherited setters while constructing checked maps", () => {
    const input = {
      additionalProperties: false,
      properties: {
        score: { maximum: 2, minimum: 0, type: "number" }
      },
      required: ["score"],
      type: "object"
    };
    const original = Object.getOwnPropertyDescriptor(Object.prototype, "score");
    let writes = 0;
    Object.defineProperty(Object.prototype, "score", {
      configurable: true,
      set: () => {
        writes += 1;
      }
    });
    let schema: BoundedObjectJsonSchema | undefined;
    try {
      schema = parseBoundedJsonSchema(input) as BoundedObjectJsonSchema;
      parseBoundedJsonValue(schema, { score: 1 });
    } finally {
      if (original) Object.defineProperty(Object.prototype, "score", original);
      else delete (Object.prototype as { score?: unknown }).score;
    }
    assert.equal(writes, 0);
    assert.equal(Object.hasOwn(schema!.properties, "score"), true);
  });
});
