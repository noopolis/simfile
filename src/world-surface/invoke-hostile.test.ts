import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  localRef,
  publicObservation,
  validWorldSurface,
  worldContext,
  worldLoweringInput,
  worldSenseInput
} from "./definition.test-helper.js";
import { parseWorldSurfaceDefinition } from "./index.js";

describe("hostile world surface invocation", () => {
  it("rejects Promise-like returns from every authored callback", () => {
    const sense = parseWorldSurfaceDefinition(validWorldSurface({
      project: () => Promise.resolve(publicObservation())
    }));
    assert.throws(
      () => sense.projectSense(localRef("sense:vision"), worldSenseInput()),
      /return synchronously/u
    );

    const available = parseWorldSurfaceDefinition(validWorldSurface({
      available: () => ({ then: () => undefined })
    }));
    assert.throws(
      () => available.isAffordanceAvailable(
        localRef("affordance:kick"),
        worldContext()
      ),
      /return synchronously/u
    );

    const lower = parseWorldSurfaceDefinition(validWorldSurface({
      lower: () => Promise.resolve({ force: 1 })
    }));
    assert.throws(
      () => lower.lowerAffordance(
        localRef("affordance:kick"),
        worldLoweringInput()
      ),
      /return synchronously/u
    );

    const result = parseWorldSurfaceDefinition(validWorldSurface({
      projectResult: () => Promise.resolve({ outcome: true })
    }));
    assert.throws(
      () => result.projectAffordanceResult(
        localRef("affordance:kick"),
        { accepted: true }
      ),
      /return synchronously/u
    );
  });

  it("requires boolean availability and bounded numeric projection output", () => {
    const nonBoolean = parseWorldSurfaceDefinition(validWorldSurface({
      available: () => "yes"
    }));
    assert.throws(
      () => nonBoolean.isAffordanceAvailable(
        localRef("affordance:kick"),
        worldContext()
      ),
      /must return boolean/u
    );

    const emptyComponents = parseWorldSurfaceDefinition(validWorldSurface({
      project: () => ({
        channels: [{
          components: {},
          sense_address: "sense:vision",
          subject_address: "entity:red"
        }]
      })
    }));
    assert.throws(
      () => emptyComponents.projectSense(localRef("sense:vision"), worldSenseInput()),
      /bounded non-empty component object/u
    );

    const duplicateChannels = parseWorldSurfaceDefinition(validWorldSurface({
      project: () => {
        const channel = publicObservation().channels[0];
        return { channels: [channel, { ...channel }] };
      }
    }));
    assert.throws(
      () => duplicateChannels.projectSense(
        localRef("sense:vision"),
        worldSenseInput()
      ),
      /unique addresses/u
    );

    const nonFinite = parseWorldSurfaceDefinition(validWorldSurface({
      project: () => ({
        channels: [{
          components: { x: Number.NaN },
          sense_address: "sense:vision",
          subject_address: "entity:red"
        }]
      })
    }));
    assert.throws(
      () => nonFinite.projectSense(localRef("sense:vision"), worldSenseInput()),
      /finite numbers/u
    );
  });

  it("recursively rejects host-stamped fields from lowered and projected JSON", () => {
    const lower = parseWorldSurfaceDefinition(validWorldSurface({
      lower: () => ({
        nested: {
          organization_principal: "organization:trusted"
        }
      })
    }));
    assert.throws(
      () => lower.lowerAffordance(
        localRef("affordance:kick"),
        worldLoweringInput()
      ),
      /organization_principal.*reserved for host authority/u
    );

    const result = parseWorldSurfaceDefinition(validWorldSurface({
      projectResult: () => ({
        nested: [{
          receipt_tick: 4
        }]
      })
    }));
    assert.throws(
      () => result.projectAffordanceResult(
        localRef("affordance:kick"),
        { accepted: true }
      ),
      /receipt_tick.*reserved for host authority/u
    );
  });

  it("rejects malformed lowering and result objects without running accessors", () => {
    let accessed = false;
    const lower = parseWorldSurfaceDefinition(validWorldSurface({
      lower: () => {
        const output = {};
        Object.defineProperty(output, "force", {
          enumerable: true,
          get: () => {
            accessed = true;
            return 1;
          }
        });
        return output;
      }
    }));
    assert.throws(
      () => lower.lowerAffordance(
        localRef("affordance:kick"),
        worldLoweringInput()
      ),
      /enumerable data value/u
    );
    assert.equal(accessed, false);

    const extraResult = parseWorldSurfaceDefinition(validWorldSurface());
    assert.throws(
      () => extraResult.projectAffordanceResult(
        localRef("affordance:kick"),
        { accepted: true, sequence: 1 } as never
      ),
      /unknown field sequence/u
    );
  });

  it("accepts only declared rejection codes and consistent dispositions", () => {
    const registry = parseWorldSurfaceDefinition(validWorldSurface());
    assert.throws(
      () => registry.projectAffordanceResult(
        localRef("affordance:kick"),
        { accepted: false, code: "secret" }
      ),
      /undeclared rejection code/u
    );
    assert.throws(
      () => registry.projectAffordanceResult(
        localRef("affordance:kick"),
        { accepted: false }
      ),
      /undeclared rejection code/u
    );
    assert.throws(
      () => registry.projectAffordanceResult(
        localRef("affordance:kick"),
        { accepted: true, code: "blocked" }
      ),
      /must not declare code/u
    );
    assert.throws(
      () => registry.projectAffordanceResult(
        localRef("affordance:kick"),
        { accepted: true, message: "x".repeat(4_097) }
      ),
      /bounded string/u
    );
  });

  it("rejects malformed host inputs and effect payloads before callback use", () => {
    let accessed = false;
    const context = worldContext();
    Object.defineProperty(context, "holder", {
      enumerable: true,
      get: () => {
        accessed = true;
        return localRef("entity:red");
      }
    });
    const registry = parseWorldSurfaceDefinition(validWorldSurface());
    assert.throws(
      () => registry.isAffordanceAvailable(localRef("affordance:kick"), context),
      /enumerable data value/u
    );
    assert.equal(accessed, false);

    const inheritedPayload = Object.assign(
      Object.create({ authority: true }) as object,
      { strength: 1 }
    );
    assert.throws(
      () => registry.projectEffect("impact", inheritedPayload),
      /plain JSON objects/u
    );
    assert.throws(
      () => registry.projectEffect("impact", { strength: 1, extra: true }),
      /outside the declared object bounds|not allowed/u
    );
  });

  it("ignores inherited optional callback and mechanics-result fields", () => {
    let accessed = false;
    const inherited = {
      configurable: true,
      get: () => {
        accessed = true;
        throw new Error("must not execute");
      }
    };
    Object.defineProperty(Object.prototype, "project_result", inherited);
    try {
      assert.doesNotThrow(() =>
        parseWorldSurfaceDefinition(validWorldSurface({ projectResult: null })));
    } finally {
      delete (Object.prototype as { project_result?: unknown }).project_result;
    }
    assert.equal(accessed, false);

    const registry = parseWorldSurfaceDefinition(validWorldSurface());
    Object.defineProperty(Object.prototype, "code", inherited);
    try {
      assert.doesNotThrow(() =>
        registry.projectAffordanceResult(
          localRef("affordance:kick"),
          { accepted: true }
        ));
    } finally {
      delete (Object.prototype as { code?: unknown }).code;
    }
    assert.equal(accessed, false);
  });
});
