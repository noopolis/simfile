import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type {
  WorldAffordanceLoweringInput,
  WorldSenseProjectionInput
} from "./types.js";
import {
  localRef,
  publicObservation,
  validWorldSurface,
  worldLoweringInput,
  worldSenseInput
} from "./definition.test-helper.js";
import { parseWorldSurfaceDefinition } from "./index.js";
import { parseWorldSurfaceObservation } from "./observation.js";

const installGetter = (
  key: string,
  inherited: unknown
): { readonly reads: () => number; readonly restore: () => void } => {
  const original = Object.getOwnPropertyDescriptor(Object.prototype, key);
  let readCount = 0;
  Object.defineProperty(Object.prototype, key, {
    configurable: true,
    get: () => {
      readCount += 1;
      return inherited;
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

const withPrototypeData = (
  values: Readonly<Record<string, unknown>>,
  check: () => void
): void => {
  const originals = new Map<string, PropertyDescriptor | undefined>();
  try {
    for (const [key, value] of Object.entries(values)) {
      originals.set(key, Object.getOwnPropertyDescriptor(Object.prototype, key));
      Object.defineProperty(Object.prototype, key, {
        configurable: true,
        value
      });
    }
    check();
  } finally {
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(Object.prototype, key, descriptor);
      else delete (Object.prototype as Record<string, unknown>)[key];
    }
  }
};

const bareObservation = () => ({
  channels: [{
    components: { x: 1 },
    sense_address: "sense:state",
    subject_address: "object:internal"
  }]
});

describe("world observation and authority prototype isolation", () => {
  it("requires own observation fields without executing inherited getters", () => {
    const cases: ReadonlyArray<readonly [string, unknown, unknown]> = [
      ["channels", {}, []],
      ["components", {
        channels: [{
          sense_address: "sense:state",
          subject_address: "object:internal"
        }]
      }, { x: 1 }],
      ["sense_address", {
        channels: [{
          components: { x: 1 },
          subject_address: "object:internal"
        }]
      }, "sense:state"],
      ["subject_address", {
        channels: [{
          components: { x: 1 },
          sense_address: "sense:state"
        }]
      }, "object:internal"]
    ];
    for (const [key, input, inherited] of cases) {
      const getter = installGetter(key, inherited);
      let error: unknown;
      try {
        try {
          parseWorldSurfaceObservation(input, "observation");
        } catch (caught) {
          error = caught;
        }
      } finally {
        getter.restore();
      }
      assert.equal(getter.reads(), 0, key);
      assert.ok(error instanceof TypeError, key);
    }
  });

  it("own-reads optional channel fields and returns stable frozen records", () => {
    for (const [key, inherited] of [
      ["frame", "frame:poison"],
      ["unit", "meters"]
    ] as const) {
      const getter = installGetter(key, inherited);
      let observation: ReturnType<typeof parseWorldSurfaceObservation> | undefined;
      try {
        observation = parseWorldSurfaceObservation(bareObservation(), "observation");
      } finally {
        getter.restore();
      }
      assert.equal(getter.reads(), 0, key);
      assert.equal(Object.hasOwn(observation!.channels[0], key), false);
    }

    const observation = parseWorldSurfaceObservation(bareObservation(), "observation");
    const channel = observation.channels[0];
    assert.equal(Object.getPrototypeOf(observation), null);
    assert.equal(Object.getPrototypeOf(channel), null);
    assert.equal(Object.getPrototypeOf(channel.components), null);
    assert.equal(Object.isFrozen(observation), true);
    assert.equal(Object.isFrozen(channel), true);
    assert.equal(Object.isFrozen(channel.components), true);
    withPrototypeData({
      frame: "frame:poison",
      observer: "principal:poison",
      receipt_sequence: 42,
      unit: "poison"
    }, () => {
      assert.equal(channel.frame, undefined);
      assert.equal(channel.unit, undefined);
      assert.equal(
        (channel.components as Readonly<Record<string, unknown>>).receipt_sequence,
        undefined
      );
      assert.equal(
        (observation as unknown as Readonly<Record<string, unknown>>).observer,
        undefined
      );
    });
  });

  it("does not invoke inherited setters while constructing components", () => {
    const input = bareObservation();
    const original = Object.getOwnPropertyDescriptor(Object.prototype, "x");
    let writes = 0;
    Object.defineProperty(Object.prototype, "x", {
      configurable: true,
      set: () => {
        writes += 1;
      }
    });
    let observation: ReturnType<typeof parseWorldSurfaceObservation> | undefined;
    try {
      observation = parseWorldSurfaceObservation(input, "observation");
    } finally {
      if (original) Object.defineProperty(Object.prototype, "x", original);
      else delete (Object.prototype as { x?: unknown }).x;
    }
    assert.equal(writes, 0);
    assert.equal(observation!.channels[0].components.x, 1);
  });

  it("rejects authority fields in public projected sense components", () => {
    for (const field of ["receipt_sequence", "observer"]) {
      const registry = parseWorldSurfaceDefinition(validWorldSurface({
        project: () => ({
          channels: [{
            components: { [field]: 42 },
            sense_address: "sense:vision",
            subject_address: "entity:red"
          }]
        })
      }));
      assert.throws(
        () => registry.projectSense(localRef("sense:vision"), worldSenseInput()),
        new RegExp(`${field}.*reserved for host authority`, "u")
      );
    }
  });

  it("rejects observer in authored schemas and callback JSON outputs", () => {
    for (const locate of ["action", "effect"] as const) {
      const surface = validWorldSurface();
      const schema = {
        additionalProperties: false,
        properties: {
          observer: { maxLength: 16, type: "string" }
        },
        type: "object"
      };
      if (locate === "action") {
        (surface.affordances["affordance:kick"] as unknown as
          { input_schema: unknown }).input_schema = schema;
      } else {
        (surface.effects["effect:impact"] as unknown as
          { payload_schema: unknown }).payload_schema = schema;
      }
      assert.throws(
        () => parseWorldSurfaceDefinition(surface),
        /observer.*reserved for host authority/u
      );
    }

    const lower = parseWorldSurfaceDefinition(validWorldSurface({
      lower: () => ({ nested: { observer: "principal:red" } })
    }));
    assert.throws(
      () => lower.lowerAffordance(localRef("affordance:kick"), worldLoweringInput()),
      /observer.*reserved for host authority/u
    );

    const result = parseWorldSurfaceDefinition(validWorldSurface({
      projectResult: () => ({ nested: { observer: "principal:red" } })
    }));
    assert.throws(
      () => result.projectAffordanceResult(
        localRef("affordance:kick"),
        { accepted: true }
      ),
      /observer.*reserved for host authority/u
    );
  });

  it("stabilizes callback inputs, effect payloads, lowering, and result maps", () => {
    let loweringInput: WorldAffordanceLoweringInput | undefined;
    let senseInput: WorldSenseProjectionInput | undefined;
    const registry = parseWorldSurfaceDefinition(validWorldSurface({
      lower: (input) => {
        loweringInput = input as WorldAffordanceLoweringInput;
        return { nested: { force: loweringInput.input.force } };
      },
      project: (input) => {
        senseInput = input as WorldSenseProjectionInput;
        return publicObservation();
      }
    }));
    const observation = registry.projectSense(localRef("sense:vision"), {
      holder: localRef("entity:red"),
      observation: bareObservation()
    });
    const lowered = registry.lowerAffordance(
      localRef("affordance:kick"),
      worldLoweringInput()
    );
    const result = registry.projectAffordanceResult(
      localRef("affordance:kick"),
      { accepted: true }
    )!;
    const effect = registry.projectEffect("impact", { strength: 1 });

    assert.equal(Object.getPrototypeOf(loweringInput!.input), null);
    assert.equal(Object.getPrototypeOf(senseInput!.observation), null);
    assert.equal(Object.getPrototypeOf(observation.channels[0].components), null);
    assert.equal(Object.getPrototypeOf(lowered), null);
    assert.equal(Object.getPrototypeOf(lowered.nested), null);
    assert.equal(Object.getPrototypeOf(result), null);
    assert.equal(Object.getPrototypeOf(effect), null);
    assert.equal(Object.getPrototypeOf(effect.payload), null);

    withPrototypeData({
      frame: "frame:poison",
      observer: "principal:poison",
      receipt_sequence: 42,
      unit: "poison"
    }, () => {
      const sourceChannel = senseInput!.observation.channels[0];
      assert.equal(sourceChannel.frame, undefined);
      assert.equal(sourceChannel.unit, undefined);
      assert.equal(
        (sourceChannel.components as Readonly<Record<string, unknown>>).receipt_sequence,
        undefined
      );
      for (const value of [loweringInput!.input, lowered, result, effect.payload]) {
        assert.equal(
          (value as Readonly<Record<string, unknown>>).observer,
          undefined
        );
      }
    });
  });
});
