import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type {
  WorldAffordanceContext,
  WorldAffordanceLoweringInput,
  WorldSenseProjectionInput
} from "./types.js";
import {
  localRef,
  mechanicsObservation,
  publicObservation,
  validWorldSurface,
  worldContext,
  worldLoweringInput,
  worldSenseInput
} from "./definition.test-helper.js";
import { parseWorldSurfaceDefinition, readWorldSurfaceRejection } from "./index.js";

const nestedRequiredInputSchema = () => ({
  additionalProperties: false,
  properties: {
    vector: {
      additionalProperties: false,
      properties: {
        magnitude: {
          maximum: 1,
          minimum: 0,
          type: "number"
        }
      },
      required: ["magnitude"],
      type: "object"
    }
  },
  required: ["vector"],
  type: "object"
});

describe("checked world surface invocation", () => {
  it("clones and deeply freezes mechanics observations before sense projection", () => {
    const source = worldSenseInput();
    const projectedSource = publicObservation();
    let seen: WorldSenseProjectionInput | undefined;
    const registry = parseWorldSurfaceDefinition(validWorldSurface({
      project: (input) => {
        seen = input as WorldSenseProjectionInput;
        assert.notEqual(seen, source);
        assert.notEqual(seen.observation, source.observation);
        assert.equal(Object.isFrozen(seen), true);
        assert.equal(Object.isFrozen(seen.observation), true);
        assert.equal(Object.isFrozen(seen.observation.channels), true);
        assert.equal(Object.isFrozen(seen.observation.channels[0]), true);
        assert.equal(Object.isFrozen(seen.observation.channels[0].components), true);
        assert.equal(seen.observation.channels[0].subject_address, "object:internal-wall");
        return projectedSource;
      }
    }));

    const projected = registry.projectSense(localRef("sense:vision"), source);
    assert.ok(seen);
    assert.notEqual(projected, projectedSource);
    assert.equal(Object.isFrozen(projected), true);
    assert.equal(Object.isFrozen(projected.channels), true);
    assert.equal(Object.isFrozen(projected.channels[0].components), true);
    assert.deepEqual(JSON.parse(JSON.stringify(projected)), projectedSource);
  });

  it("limits sense source channels but permits internal mechanics subjects", () => {
    const registry = parseWorldSurfaceDefinition(validWorldSurface());
    const internal = worldSenseInput();
    assert.doesNotThrow(() =>
      registry.projectSense(localRef("sense:vision"), internal));

    const undeclared = {
      holder: localRef("entity:red"),
      observation: mechanicsObservation("sense:secret", "object:secret")
    };
    assert.throws(
      () => registry.projectSense(localRef("sense:vision"), undeclared),
      /undeclared mechanics sense/u
    );
  });

  it("requires projected channels to name the invoked public sense and public entities", () => {
    const wrongSense = parseWorldSurfaceDefinition(validWorldSurface({
      project: () => ({
        channels: [{
          components: { x: 1 },
          sense_address: "sense:secret",
          subject_address: "entity:red"
        }]
      })
    }));
    assert.throws(
      () => wrongSense.projectSense(localRef("sense:vision"), worldSenseInput()),
      /undeclared or different public sense/u
    );

    const wrongEntity = parseWorldSurfaceDefinition(validWorldSurface({
      project: () => ({
        channels: [{
          components: { x: 1 },
          sense_address: "sense:vision",
          subject_address: "entity:secret"
        }]
      })
    }));
    assert.throws(
      () => wrongEntity.projectSense(localRef("sense:vision"), worldSenseInput()),
      /undeclared/u
    );
  });

  it("guards availability and lowering with public, immutable contexts", () => {
    let availableInput: WorldAffordanceContext | undefined;
    let loweringInput: WorldAffordanceLoweringInput | undefined;
    const registry = parseWorldSurfaceDefinition(validWorldSurface({
      available: (input) => {
        availableInput = input as WorldAffordanceContext;
        return false;
      },
      lower: (input) => {
        loweringInput = input as WorldAffordanceLoweringInput;
        return { nested: { force: loweringInput.input.force } };
      }
    }));
    const context = worldContext();
    const lowering = worldLoweringInput();

    assert.equal(
      registry.isAffordanceAvailable(localRef("affordance:kick"), context),
      false
    );
    assert.ok(availableInput);
    assert.notEqual(availableInput, context);
    assert.notEqual(availableInput.observation, context.observation);
    assert.equal(Object.isFrozen(availableInput), true);
    assert.equal(Object.isFrozen(availableInput.observation.channels[0].components), true);

    const mechanics = registry.lowerAffordance(
      localRef("affordance:kick"),
      lowering
    );
    assert.ok(loweringInput);
    assert.notEqual(loweringInput.input, lowering.input);
    assert.equal(Object.isFrozen(loweringInput), true);
    assert.equal(Object.isFrozen(loweringInput.input), true);
    assert.equal(Object.isFrozen(mechanics), true);
    assert.equal(Object.isFrozen(mechanics.nested), true);
    assert.deepEqual(JSON.parse(JSON.stringify(mechanics)), { nested: { force: 0.5 } });
  });

  it("rejects a missing top-level required action input property", () => {
    const registry = parseWorldSurfaceDefinition(validWorldSurface());

    assert.throws(
      () => registry.lowerAffordance(
        localRef("affordance:kick"),
        worldLoweringInput({})
      ),
      (error: unknown) => {
        assert.ok(error instanceof TypeError);
        assert.equal(error.message, "world action input.force is required");
        assert.deepEqual(readWorldSurfaceRejection(error), {
          reason: "action_input_missing_field",
          fieldPath: "force",
        });
        return true;
      }
    );
  });

  it("validates required action input before invoking the lower callback", () => {
    const lowerCalls: unknown[] = [];
    const registry = parseWorldSurfaceDefinition(validWorldSurface({
      lower: (input) => {
        lowerCalls.push(input);
        return {};
      }
    }));

    assert.throws(
      () => registry.lowerAffordance(
        localRef("affordance:kick"),
        worldLoweringInput({})
      ),
      (error: unknown) => {
        assert.ok(error instanceof TypeError);
        assert.equal(error.message, "world action input.force is required");
        return true;
      }
    );
    assert.deepEqual(lowerCalls, []);
  });

  it("composes the path for a missing nested required action input property", () => {
    const action = validWorldSurface();
    (
      action.affordances["affordance:kick"] as unknown as { input_schema: unknown }
    ).input_schema = nestedRequiredInputSchema();
    const registry = parseWorldSurfaceDefinition(action);

    assert.throws(
      () => registry.lowerAffordance(
        localRef("affordance:kick"),
        worldLoweringInput({ vector: {} })
      ),
      (error: unknown) => {
        assert.ok(error instanceof TypeError);
        assert.equal(
          error.message,
          "world action input.vector.magnitude is required"
        );
        assert.deepEqual(readWorldSurfaceRejection(error), {
          reason: "action_input_missing_field",
          fieldPath: "vector.magnitude",
        });
        return true;
      }
    );
  });

  it("lowers a complete nested required action input unchanged", () => {
    const action = validWorldSurface({
      lower: (input) => (input as WorldAffordanceLoweringInput).input
    });
    (
      action.affordances["affordance:kick"] as unknown as { input_schema: unknown }
    ).input_schema = nestedRequiredInputSchema();
    const registry = parseWorldSurfaceDefinition(action);
    const input = { vector: { magnitude: 0.5 } };

    const mechanics = registry.lowerAffordance(
      localRef("affordance:kick"),
      worldLoweringInput(input)
    );

    assert.deepEqual(JSON.parse(JSON.stringify(mechanics)), input);
  });

  it("surfaces missing required input only when lowering an available affordance", () => {
    const registry = parseWorldSurfaceDefinition(validWorldSurface());
    const context = worldContext();
    const lowering = worldLoweringInput({});

    assert.equal(
      registry.isAffordanceAvailable(localRef("affordance:kick"), context),
      true
    );
    assert.equal(lowering.holder, context.holder);
    assert.equal(lowering.target, context.target);
    // Availability has no input to validate; missing required fields surface only at
    // lowering time as a hard TypeError.
    assert.throws(
      () => registry.lowerAffordance(localRef("affordance:kick"), lowering),
      (error: unknown) => {
        assert.ok(error instanceof TypeError);
        assert.equal(error.message, "world action input.force is required");
        return true;
      }
    );
  });

  it("validates public action input, selectors, and context observations", () => {
    const registry = parseWorldSurfaceDefinition(validWorldSurface());
    assert.throws(
      () => registry.lowerAffordance(
        localRef("affordance:kick"),
        worldLoweringInput({ force: 2 })
      ),
      /numeric bounds/u
    );

    const wrongTarget = {
      ...worldContext(),
      target: localRef("entity:red")
    };
    assert.throws(
      () => registry.isAffordanceAvailable(localRef("affordance:kick"), wrongTarget),
      /outside its declared selector/u
    );

    const internalObservation = {
      ...worldContext(),
      observation: mechanicsObservation()
    };
    assert.throws(
      () => registry.isAffordanceAvailable(
        localRef("affordance:kick"),
        internalObservation
      ),
      /undeclared or different public sense/u
    );
  });

  it("validates optional mechanics result fields and projects bounded effects", () => {
    const registry = parseWorldSurfaceDefinition(validWorldSurface());
    assert.deepEqual(
      JSON.parse(JSON.stringify(registry.projectAffordanceResult(
        localRef("affordance:kick"),
        { accepted: true }
      ))),
      { outcome: true }
    );
    assert.deepEqual(
      JSON.parse(JSON.stringify(registry.projectAffordanceResult(
        localRef("affordance:kick"),
        { accepted: false, code: "blocked" }
      ))),
      { outcome: false }
    );

    const effectPayload = { strength: 3 };
    const effect = registry.projectEffect("impact", effectPayload);
    assert.deepEqual(JSON.parse(JSON.stringify(effect)), {
      effect: "effect:impact",
      payload: effectPayload
    });
    assert.notEqual(effect.payload, effectPayload);
    assert.equal(Object.isFrozen(effect), true);
    assert.equal(Object.isFrozen(effect.payload), true);

    assert.throws(() => registry.projectEffect("secret", effectPayload), /undeclared/u);
    assert.throws(() => registry.projectEffect("impact", { strength: 20 }), /numeric bounds/u);

    const withoutProjection = parseWorldSurfaceDefinition(
      validWorldSurface({ projectResult: null })
    );
    assert.equal(
      withoutProjection.projectAffordanceResult(
        localRef("affordance:kick"),
        { accepted: true }
      ),
      undefined
    );
  });
});
