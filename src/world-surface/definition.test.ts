import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  parseWorldSurfaceDefinition,
  WORLD_SURFACE_API_VERSION
} from "./index.js";
import { validWorldSurface } from "./definition.test-helper.js";

const nestedReservedSchema = (field: string) => ({
  additionalProperties: false,
  properties: {
    nested: {
      additionalProperties: false,
      properties: {
        [field]: {
          maxLength: 8,
          type: "string"
        }
      },
      type: "object"
    }
  },
  type: "object"
});

describe("world surface definition boundary", () => {
  it("returns sorted immutable checked metadata without exposing callbacks", () => {
    const source = validWorldSurface();
    const registry = parseWorldSurfaceDefinition(source);

    assert.equal(registry.api_version, WORLD_SURFACE_API_VERSION);
    assert.deepEqual(registry.entities.map(({ alias }) => alias), ["ball", "red"]);
    assert.deepEqual(registry.senses.map(({ address }) => address), ["sense:vision"]);
    assert.deepEqual(
      registry.affordances.map(({ address }) => address),
      ["affordance:kick"]
    );
    assert.equal(Object.isFrozen(registry), true);
    assert.equal(Object.isFrozen(registry.entities), true);
    assert.equal(Object.isFrozen(registry.entities[0]), true);
    assert.equal(Object.isFrozen(registry.affordances[0].input_schema), true);
    assert.equal(
      Object.isFrozen(registry.affordances[0].input_schema.properties),
      true
    );
    assert.equal("available" in registry.affordances[0], false);
    assert.equal("lower" in registry.affordances[0], false);
    assert.equal("project" in registry.senses[0], false);
    assert.equal("callbacks" in registry, false);

    source.entities.red.address = "entity:ball";
    source.senses["sense:vision"].dynamics_senses[0] = "sense:other";
    assert.equal(registry.entities[1].address, "entity:red");
    assert.deepEqual(registry.senses[0].dynamics_senses, ["sense:state"]);
  });

  it("requires the exact API and own enumerable data declarations", () => {
    const extra = validWorldSurface() as unknown as Record<string, unknown>;
    extra.extra = true;
    assert.throws(() => parseWorldSurfaceDefinition(extra), /unknown field extra/u);

    const wrongApi = validWorldSurface();
    (wrongApi as unknown as { api_version: unknown }).api_version = "future";
    assert.throws(() => parseWorldSurfaceDefinition(wrongApi), /api_version/u);

    const accessor = validWorldSurface();
    Object.defineProperty(accessor, "effects", {
      enumerable: true,
      get: () => {
        throw new Error("must not execute");
      }
    });
    assert.throws(
      () => parseWorldSurfaceDefinition(accessor),
      /effects must be an enumerable data value/u
    );

    const inherited = validWorldSurface();
    Object.setPrototypeOf(inherited, { authority: true });
    assert.throws(() => parseWorldSurfaceDefinition(inherited), /plain object/u);

    let kindAccessed = false;
    const missingKind = validWorldSurface();
    delete (
      missingKind.affordances["affordance:kick"].target_selector as unknown as
      { kind?: unknown }
    ).kind;
    Object.defineProperty(Object.prototype, "kind", {
      configurable: true,
      get: () => {
        kindAccessed = true;
        throw new Error("must not execute");
      }
    });
    try {
      assert.throws(
        () => parseWorldSurfaceDefinition(missingKind),
        /target_selector.kind is required/u
      );
    } finally {
      delete (Object.prototype as { kind?: unknown }).kind;
    }
    assert.equal(kindAccessed, false);
  });

  it("enforces local reference kinds, entity alias identity, and declared targets", () => {
    const mismatch = validWorldSurface();
    mismatch.entities.red.address = "entity:ball";
    assert.throws(() => parseWorldSurfaceDefinition(mismatch), /must equal entity:red/u);

    const wrongSense = validWorldSurface();
    const senses = wrongSense.senses as unknown as Record<string, unknown>;
    senses["effect:vision"] = senses["sense:vision"];
    delete senses["sense:vision"];
    assert.throws(
      () => parseWorldSurfaceDefinition(wrongSense),
      /sense: reference kind|local sense reference/u
    );

    const wrongEffect = validWorldSurface();
    const effects = wrongEffect.effects as unknown as Record<string, unknown>;
    effects["affordance:impact"] = effects["effect:impact"];
    delete effects["effect:impact"];
    assert.throws(
      () => parseWorldSurfaceDefinition(wrongEffect),
      /effect: reference kind|local effect reference/u
    );

    const undeclared = validWorldSurface();
    undeclared.affordances["affordance:kick"].target_selector.targets = ["entity:blue"];
    assert.throws(() => parseWorldSurfaceDefinition(undeclared), /undeclared target/u);
  });

  it("requires exact canonical mechanics entity and sense kinds", () => {
    const entityKind = validWorldSurface();
    entityKind.entities.ball.dynamics_address = "sense:ball";
    assert.throws(() => parseWorldSurfaceDefinition(entityKind), /object: mechanics kind/u);

    const senseKind = validWorldSurface();
    senseKind.senses["sense:vision"].dynamics_senses = ["object:ball"];
    assert.throws(() => parseWorldSurfaceDefinition(senseKind), /sense: mechanics kind/u);

    const action = validWorldSurface();
    action.affordances["affordance:kick"].dynamics_action = "Kick!";
    assert.throws(() => parseWorldSurfaceDefinition(action), /not canonical/u);

    const event = validWorldSurface();
    event.effects["effect:impact"].dynamics_event = "bad event";
    assert.throws(() => parseWorldSurfaceDefinition(event), /not canonical/u);
  });

  it("rejects duplicate mappings, lists, and rejection codes", () => {
    const entityMapping = validWorldSurface();
    entityMapping.entities.red.dynamics_address = "object:ball";
    assert.throws(
      () => parseWorldSurfaceDefinition(entityMapping),
      /duplicate mechanics entity address/u
    );

    const senses = validWorldSurface();
    senses.senses["sense:vision"].dynamics_senses = ["sense:state", "sense:state"];
    assert.throws(() => parseWorldSurfaceDefinition(senses), /must be unique/u);

    const codes = validWorldSurface();
    codes.affordances["affordance:kick"].rejection_codes = ["blocked", "blocked"];
    assert.throws(() => parseWorldSurfaceDefinition(codes), /must be unique/u);

    const targets = validWorldSurface();
    targets.affordances["affordance:kick"].target_selector.targets = [
      "entity:ball",
      "entity:ball"
    ];
    assert.throws(() => parseWorldSurfaceDefinition(targets), /must be unique/u);

    const events = validWorldSurface();
    (events.effects as unknown as Record<string, unknown>)["effect:echo"] = {
      dynamics_event: "impact",
      payload_schema: {
        additionalProperties: false,
        properties: {},
        type: "object"
      }
    };
    assert.throws(() => parseWorldSurfaceDefinition(events), /duplicate mechanics event/u);
  });

  it("rejects reserved host-authority names throughout input and effect schemas", () => {
    for (const field of [
      "act_id",
      "action",
      "action_id",
      "actor",
      "application_sequence",
      "application_tick",
      "apply_tick",
      "at_tick",
      "authorization",
      "bearer",
      "decision_id",
      "decision_token",
      "event_sequence",
      "grants",
      "holder",
      "organization_principal",
      "manifest_digest",
      "observation_id",
      "observed_tick",
      "observer",
      "origin",
      "principal",
      "principal_id",
      "provenance",
      "receipt_sequence",
      "receipt_tick",
      "request_id",
      "run_id",
      "sequence",
      "state_version",
      "target",
      "tick",
      "token",
      "world",
      "world_entity",
      "world_id",
      "world_instance_id"
    ]) {
      const action = validWorldSurface();
      (
        action.affordances["affordance:kick"] as unknown as { input_schema: unknown }
      ).input_schema = nestedReservedSchema(field);
      assert.throws(
        () => parseWorldSurfaceDefinition(action),
        /reserved for host authority/u
      );
    }

    const effect = validWorldSurface();
    (
      effect.effects["effect:impact"] as unknown as { payload_schema: unknown }
    ).payload_schema = nestedReservedSchema("receipt_sequence");
    assert.throws(
      () => parseWorldSurfaceDefinition(effect),
      /reserved for host authority/u
    );
  });

  it("reserves entity for action inputs without banning world-owned effect data", () => {
    for (const schema of [
      {
        additionalProperties: false,
        properties: { entity: { maxLength: 8, type: "string" } },
        type: "object"
      },
      nestedReservedSchema("entity")
    ]) {
      const action = validWorldSurface();
      (
        action.affordances["affordance:kick"] as unknown as { input_schema: unknown }
      ).input_schema = schema;
      assert.throws(
        () => parseWorldSurfaceDefinition(action),
        /entity.*reserved for host authority/u
      );
    }

    const effect = validWorldSurface();
    (
      effect.effects["effect:impact"] as unknown as { payload_schema: unknown }
    ).payload_schema = {
      additionalProperties: false,
      properties: {
        entity: { maxLength: 64, type: "string" },
        position: { maximum: 100, minimum: 0, type: "number" }
      },
      type: "object"
    };
    assert.doesNotThrow(() => parseWorldSurfaceDefinition(effect));
  });

  it("rejects async declarations and bounded declaration overflows", () => {
    const callbacks = [
      () => {
        const surface = validWorldSurface();
        surface.senses["sense:vision"].project = async () => ({ channels: [] });
        return surface;
      },
      () => {
        const surface = validWorldSurface();
        surface.affordances["affordance:kick"].available = async () => true;
        return surface;
      },
      () => {
        const surface = validWorldSurface();
        surface.affordances["affordance:kick"].lower = async () => ({});
        return surface;
      },
      () => {
        const surface = validWorldSurface();
        surface.affordances["affordance:kick"].project_result = async () => ({});
        return surface;
      }
    ];
    callbacks.forEach((makeSurface) => {
      assert.throws(() => parseWorldSurfaceDefinition(makeSurface()), /must be synchronous/u);
    });

    const tooMany = validWorldSurface();
    const effects = tooMany.effects as unknown as Record<string, unknown>;
    for (let index = 0; index < 129; index += 1) {
      effects[`effect:e-${index}`] = effects["effect:impact"];
    }
    assert.throws(() => parseWorldSurfaceDefinition(tooMany), /declaration limit/u);

    const tooLong = validWorldSurface();
    tooLong.effects["effect:impact"].dynamics_event = "a".repeat(257);
    assert.throws(() => parseWorldSurfaceDefinition(tooLong), /bounded string/u);
  });
});
