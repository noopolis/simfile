import assert from "node:assert/strict";
import test from "node:test";

import {
  DYNAMICS_RUN_ACTION_SOURCE_VERSION,
  parseDynamicsRunActionSourceDeclaration
} from "./runActionSource.js";

const valid = () => ({
  id: "scripted-source",
  live_acceptance: false as const,
  onTick() {},
  participants: ["blue", "red"],
  provenance: "scripted" as const,
  version: DYNAMICS_RUN_ACTION_SOURCE_VERSION
});

const declared = new Set(["blue", "red"]);

test("parses and freezes the exact scripted non-live declaration", () => {
  const raw = valid();
  const source = parseDynamicsRunActionSourceDeclaration(raw, declared);
  assert.deepEqual(
    { ...source, onTick: undefined },
    { ...raw, onTick: undefined }
  );
  assert.equal(source.onTick, raw.onTick);
  assert.equal(Object.isFrozen(source), true);
  assert.equal(Object.isFrozen(source.participants), true);
});

test("requires exact declaration fields and ordinary data properties", () => {
  assert.throws(
    () => parseDynamicsRunActionSourceDeclaration(
      { ...valid(), extra: true },
      declared
    ),
    /must contain exactly/u
  );
  const accessor = valid() as Record<string, unknown>;
  Object.defineProperty(accessor, "id", {
    enumerable: true,
    get: () => "hostile"
  });
  assert.throws(
    () => parseDynamicsRunActionSourceDeclaration(accessor, declared),
    /enumerable data value/u
  );
  assert.throws(
    () => parseDynamicsRunActionSourceDeclaration(
      new Proxy(valid(), {}),
      declared
    ),
    /ordinary object/u
  );
  assert.throws(
    () => parseDynamicsRunActionSourceDeclaration(
      Object.assign(Object.create(null), valid()),
      declared
    ),
    /ordinary object/u
  );
});

test("requires the exact version and closed provenance vocabulary", () => {
  assert.throws(
    () => parseDynamicsRunActionSourceDeclaration(
      { ...valid(), version: "v2" },
      declared
    ),
    /version must be simfile\.dynamics-run-action-source\.v1/u
  );
  assert.throws(
    () => parseDynamicsRunActionSourceDeclaration(
      { ...valid(), provenance: "live" },
      declared
    ),
    /provenance is unsupported/u
  );
  const model = parseDynamicsRunActionSourceDeclaration(
    { ...valid(), provenance: "model" },
    declared
  );
  assert.equal(model.provenance, "model");
  assert.equal(model.live_acceptance, false);
});

test("requires sorted unique declared participant ids", () => {
  for (const [participants, message] of [
    [[], /non-empty ordinary array/u],
    [["red", "blue"], /code-point order/u],
    [["blue", "blue"], /unique/u],
    [["blue", "other"], /not declared in world\.grants/u],
    [[" blue", "red"], /non-empty trimmed string/u]
  ] as const) {
    assert.throws(
      () => parseDynamicsRunActionSourceDeclaration(
        { ...valid(), participants },
        declared
      ),
      message
    );
  }
});

test("rejects sparse, accessor, extended, subclassed, and proxied arrays", () => {
  const sparse = ["blue", "red"];
  delete sparse[0];
  const accessor = ["blue", "red"];
  Object.defineProperty(accessor, "0", {
    enumerable: true,
    get: () => "blue"
  });
  const extended = Object.assign(["blue", "red"], { extra: true });
  class ParticipantList extends Array<string> {}
  const subclassed = new ParticipantList("blue", "red");
  for (const participants of [
    sparse,
    accessor,
    extended,
    subclassed,
    new Proxy(["blue", "red"], {})
  ]) {
    assert.throws(
      () => parseDynamicsRunActionSourceDeclaration(
        { ...valid(), participants },
        declared
      ),
      /ordinary array|dense data array/u
    );
  }
});

test("requires an onTick function and bounded source identity", () => {
  assert.throws(
    () => parseDynamicsRunActionSourceDeclaration(
      { ...valid(), onTick: 1 },
      declared
    ),
    /onTick must be a function/u
  );
  assert.throws(
    () => parseDynamicsRunActionSourceDeclaration(
      { ...valid(), id: "x".repeat(257) },
      declared
    ),
    /identifier code-unit limit/u
  );
});
