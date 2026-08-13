import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  localRef,
  validWorldSurface,
  worldContext
} from "./definition.test-helper.js";
import { parseWorldSurfaceDefinition } from "./index.js";

const invokeAvailability = (available: () => unknown): boolean => {
  const registry = parseWorldSurfaceDefinition(validWorldSurface({ available }));
  return registry.isAffordanceAvailable(
    localRef("affordance:kick"),
    worldContext()
  );
};

describe("world surface synchronous return guard", () => {
  it("rejects constructor accessors without reading them", () => {
    for (const inherited of [false, true]) {
      let reads = 0;
      const callback = () => true;
      const holder = inherited
        ? Object.create(Object.getPrototypeOf(callback)) as object
        : callback;
      Object.defineProperty(holder, "constructor", {
        configurable: true,
        get: () => {
          reads += 1;
          return Function;
        }
      });
      if (inherited) Object.setPrototypeOf(callback, holder);
      assert.throws(
        () => parseWorldSurfaceDefinition(validWorldSurface({
          available: callback
        })),
        /constructor must not be an accessor/u
      );
      assert.equal(reads, 0);
    }
  });

  it("still rejects an ordinary async declaration", () => {
    assert.throws(
      () => parseWorldSurfaceDefinition(validWorldSurface({
        available: async () => true
      })),
      /must be synchronous/u
    );
  });

  it("does not inspect a constructor accessor shadowed by data", () => {
    let reads = 0;
    const deepPrototype = {};
    Object.defineProperty(deepPrototype, "constructor", {
      get: () => {
        reads += 1;
        return Function;
      }
    });
    const shadow = Object.create(deepPrototype) as object;
    Object.defineProperty(shadow, "constructor", { value: Function });
    const callback = () => true;
    Object.setPrototypeOf(callback, shadow);
    assert.doesNotThrow(() =>
      parseWorldSurfaceDefinition(validWorldSurface({ available: callback })));
    assert.equal(reads, 0);
  });

  it("does not read an Object.prototype accessor shadowed by own data", () => {
    const original = Object.getOwnPropertyDescriptor(
      Object.prototype,
      "constructor"
    );
    assert.ok(original);
    let reads = 0;
    const callback = () => true;
    Object.defineProperty(callback, "constructor", { value: Function });
    try {
      Object.defineProperty(Object.prototype, "constructor", {
        configurable: true,
        get: () => {
          reads += 1;
          return Object;
        }
      });
      parseWorldSurfaceDefinition(validWorldSurface({ available: callback }));
    } finally {
      Object.defineProperty(Object.prototype, "constructor", original);
    }
    assert.equal(reads, 0);
  });

  it("rejects an own then getter without reading it", () => {
    let reads = 0;
    assert.throws(() => invokeAvailability(() => {
      const result = {};
      Object.defineProperty(result, "then", {
        enumerable: true,
        get: () => {
          reads += 1;
          return () => undefined;
        }
      });
      return result;
    }), /then must not be an accessor/u);
    assert.equal(reads, 0);
  });

  it("rejects an inherited then getter without reading it", () => {
    let reads = 0;
    const prototype = {};
    Object.defineProperty(prototype, "then", {
      get: () => {
        reads += 1;
        return () => undefined;
      }
    });
    assert.throws(
      () => invokeAvailability(() => Object.create(prototype) as object),
      /then must not be an accessor/u
    );
    assert.equal(reads, 0);
  });

  it("rejects a function-valued data thenable", () => {
    assert.throws(
      () => invokeAvailability(() => ({ then: () => undefined })),
      /must return synchronously/u
    );
  });

  it("rejects a genuine Promise through Promise.prototype.then", () => {
    assert.throws(
      () => invokeAvailability(() => Promise.resolve(true)),
      /must return synchronously/u
    );
  });
});
