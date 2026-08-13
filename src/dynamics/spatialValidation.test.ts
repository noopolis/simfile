import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { DYNAMICS_LIMITS } from "./limits.js";
import { parseDynamicsSpatialFrame } from "./spatialValidation.js";

const object = (id: string) => ({ id, position: [1, 2], velocity: [3, 4] });

describe("parseDynamicsSpatialFrame", () => {
  it("accepts a bounded frame and returns exactly the recorded fields", () => {
    assert.deepEqual(
      parseDynamicsSpatialFrame({
        bounds: { max: [4, 3], min: [-4, -3] },
        extra: "ignored",
        objects: [{ ...object("object:a"), extra: "ignored" }]
      }),
      {
        bounds: { max: [4, 3], min: [-4, -3] },
        objects: [{ id: "object:a", position: [1, 2], velocity: [3, 4] }]
      }
    );
  });

  it("accepts a frame with no bounds and omits the key rather than inventing one", () => {
    const frame = parseDynamicsSpatialFrame({ objects: [] });
    assert.deepEqual(frame, { objects: [] });
    assert.equal("bounds" in frame, false);
  });

  it("normalizes -0 to 0 so the in-memory frame matches its recorded bytes", () => {
    // JSON.stringify(-0) emits "0". Left unnormalized, a frame holding -0
    // would disagree with the file it was written to — a byte-identity trap,
    // not a rendering one.
    const frame = parseDynamicsSpatialFrame({
      bounds: { max: [1, 1], min: [-0, -1] },
      objects: [{ id: "object:a", position: [-0, 0], velocity: [0, -0] }]
    });
    assert.equal(Object.is(frame.objects[0]!.position[0], 0), true);
    assert.equal(Object.is(frame.objects[0]!.velocity[1], 0), true);
    assert.equal(Object.is(frame.bounds!.min[0], 0), true);
    assert.equal(JSON.stringify(frame), JSON.stringify(JSON.parse(JSON.stringify(frame))));
  });

  it("rejects non-finite numbers on every numeric axis", () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, "1", null]) {
      assert.throws(() => parseDynamicsSpatialFrame({
        objects: [{ id: "object:a", position: [bad, 0], velocity: [0, 0] }]
      }), /must be a finite number/u);
      assert.throws(() => parseDynamicsSpatialFrame({
        objects: [{ id: "object:a", position: [0, 0], velocity: [0, bad] }]
      }), /must be a finite number/u);
      assert.throws(() => parseDynamicsSpatialFrame({
        bounds: { max: [bad, 1], min: [-1, -1] },
        objects: []
      }), /must be a finite number/u);
    }
  });

  it("rejects malformed shapes rather than coercing them", () => {
    assert.throws(() => parseDynamicsSpatialFrame(null), /must return an object/u);
    assert.throws(() => parseDynamicsSpatialFrame([]), /must return an object/u);
    assert.throws(() => parseDynamicsSpatialFrame({}), /objects must be an array/u);
    assert.throws(() => parseDynamicsSpatialFrame({ objects: [1] }), /must be an object/u);
    assert.throws(() => parseDynamicsSpatialFrame({ objects: [{ ...object("") }] }),
      /id must be a non-empty string/u);
    assert.throws(() => parseDynamicsSpatialFrame({ objects: [{ ...object("  ") }] }),
      /id must be a non-empty string/u);
    assert.throws(() => parseDynamicsSpatialFrame({
      objects: [{ id: "object:a", position: [1], velocity: [0, 0] }]
    }), /must be a two-number array/u);
    assert.throws(() => parseDynamicsSpatialFrame({
      objects: [{ id: "object:a", position: [1, 2, 3], velocity: [0, 0] }]
    }), /must be a two-number array/u);
    assert.throws(() => parseDynamicsSpatialFrame({
      objects: [], bounds: 3
    }), /bounds must be an object/u);
  });

  it("rejects a degenerate or inverted extent", () => {
    for (const bounds of [
      { max: [0, 1], min: [0, -1] },
      { max: [1, -1], min: [-1, 1] }
    ]) {
      assert.throws(() => parseDynamicsSpatialFrame({ bounds, objects: [] }),
        /positive-area extent/u);
    }
  });

  it("rejects duplicate ids, which would make two bodies share one track", () => {
    assert.throws(() => parseDynamicsSpatialFrame({
      objects: [object("object:a"), object("object:a")]
    }), /duplicate ids/u);
  });

  it("bounds the object count at DYNAMICS_LIMITS.spatial_objects", () => {
    const ids = (count: number) => Array.from({ length: count },
      (_unused, index) => object(`object:${index}`));
    const limit = DYNAMICS_LIMITS.spatial_objects;
    assert.equal(parseDynamicsSpatialFrame({ objects: ids(limit) }).objects.length, limit);
    assert.throws(() => parseDynamicsSpatialFrame({ objects: ids(limit + 1) }),
      /exceeds the spatial object limit/u);
  });

  it("bounds the id length at the shared identifier limit", () => {
    const id = "o".repeat(DYNAMICS_LIMITS.identifier_code_units + 1);
    assert.throws(() => parseDynamicsSpatialFrame({ objects: [object(id)] }),
      /exceeds the identifier limit/u);
  });

  it("names the failing path so a provider bug is locatable", () => {
    assert.throws(() => parseDynamicsSpatialFrame({
      objects: [object("object:a"), { id: "object:b", position: [0, "x"], velocity: [0, 0] }]
    }), /spatial\(\)\.objects\[1\]\.position\[1\] must be a finite number/u);
  });
});
