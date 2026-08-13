import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { canonicalDynamicsJson, cloneDynamicsJson } from "./canonicalJson.js";
import { DYNAMICS_LIMITS } from "./limits.js";

describe("dynamics canonical JSON", () => {
  it("is insertion-order independent and normalizes negative zero", () => {
    assert.equal(canonicalDynamicsJson({ b: 2, a: -0 }), canonicalDynamicsJson({ a: 0, b: 2 }));
    assert.notEqual(canonicalDynamicsJson({ a: "bc" }), canonicalDynamicsJson({ ab: "c" }));
    assert.equal(Object.is((cloneDynamicsJson(-0) as number), -0), false);
  });

  it("rejects values JSON would serialize ambiguously", () => {
    const sparse: unknown[] = [];
    sparse[1] = "present";
    assert.throws(() => canonicalDynamicsJson(sparse), /sparse arrays/u);
    assert.throws(
      () => canonicalDynamicsJson(JSON.parse('{"__proto__":1}')),
      /safe dynamics JSON key/u
    );
    const withHidden = {};
    Object.defineProperty(withHidden, "hidden", { enumerable: false, value: 1 });
    assert.throws(() => canonicalDynamicsJson(withHidden), /enumerable data value/u);
  });

  it("enforces depth, node, per-string, and cumulative code-unit fuses", () => {
    let deep: unknown = null;
    for (let index = 0; index <= DYNAMICS_LIMITS.json_depth; index += 1) deep = [deep];
    assert.throws(() => canonicalDynamicsJson(deep), /depth limit/u);
    assert.throws(
      () => canonicalDynamicsJson(Array.from({ length: DYNAMICS_LIMITS.json_nodes + 1 }, () => null)),
      /node limit/u
    );
    assert.throws(
      () => canonicalDynamicsJson("x".repeat(DYNAMICS_LIMITS.json_string_length + 1)),
      /string limit/u
    );
    const multiplicative = Object.fromEntries(Array.from(
      { length: Math.floor(DYNAMICS_LIMITS.json_code_units / 1_000) + 1 },
      (_, index) => [`key_${index}`, "x".repeat(1_000)]
    ));
    assert.throws(() => canonicalDynamicsJson(multiplicative), /cumulative.*code-unit limit/u);
  });
});
