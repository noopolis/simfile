import assert from "node:assert/strict";
import test from "node:test";

import { parseSimfileSource } from "../schema/parse.js";
import {
  parseWorldSurfaceDefinition,
  WORLD_SURFACE_API_VERSION
} from "../world-surface/index.js";
import {
  assertWorldGrantManifestCount,
  composeWorldGrants,
  createLocalWorldGrantPrincipalResolver,
  localWorldGrantPrincipal
} from "./grantComposition.js";

const surface = () => parseWorldSurfaceDefinition({
  affordances: {},
  api_version: WORLD_SURFACE_API_VERSION,
  effects: {},
  entities: {
    alpha: {
      address: "entity:alpha",
      dynamics_address: "object:alpha"
    }
  },
  senses: {
    "sense:open": {
      dynamics_senses: ["sense:state"],
      output: "simfile.numeric-observation.v1",
      project: (input: {
        observation: {
          channels: readonly {
            components: Readonly<Record<string, number>>;
          }[];
        };
      }) => ({
        channels: input.observation.channels.map((channel) => ({
          components: channel.components,
          sense_address: "sense:open",
          subject_address: "entity:alpha"
        }))
      })
    }
  }
});

const world = (sense = "sense:open") => parseSimfileSource(`
simfile_version: "0.1"
name: composition-test
clock:
  seed: composition-test
  tick: 1s
world:
  id: arena
  grants:
    alpha:
      entity: entity:alpha
      senses: [${sense}]
`).simfile.world!;

test("composes resolved, locally bound grants into a participant manifest lookup", () => {
  const composition = composeWorldGrants({
    runId: "composition-run",
    surfaceRegistry: surface(),
    world: world(),
    worldInstanceId: "composition-run-world"
  });

  assert.deepEqual(composition.boundGrants, [{
    participant: "alpha",
    principal: "participant:alpha",
    entity: "world://arena/entity/alpha",
    senses: ["world://arena/sense/open"],
    affordances: []
  }]);
  assert.equal(Object.getPrototypeOf(composition.manifestsByParticipant), null);
  assert.deepEqual(Object.keys(composition.manifestsByParticipant), ["alpha"]);
  assert.equal(
    composition.manifestsByParticipant.alpha?.holder.principal,
    "participant:alpha"
  );
  assert.equal(composition.artifacts.length, 1);
});

test("local participant labels are one-to-one and are not identity claims", () => {
  const resolver = createLocalWorldGrantPrincipalResolver(["alpha", "beta"]);
  assert.equal(localWorldGrantPrincipal("alpha"), "participant:alpha");
  assert.equal(resolver.resolvePrincipal("beta"), "participant:beta");
  assert.equal(resolver.resolveParticipant("participant:alpha"), "alpha");
  assert.equal(resolver.resolvePrincipal("outsider"), undefined);
  assert.equal(resolver.resolveParticipant("participant:outsider"), undefined);
  assert.throws(
    () => createLocalWorldGrantPrincipalResolver(["alpha", "alpha"]),
    /duplicate local world grant participant/u
  );
});

test("uses a supplied principal resolver for an externally authenticated runtime", () => {
  const composition = composeWorldGrants({
    principalResolver: {
      resolveParticipant: (principal) => principal === "agent:alpha" ? "alpha" : undefined,
      resolvePrincipal: (participant) => participant === "alpha" ? "agent:alpha" : undefined,
    },
    runId: "composition-run",
    surfaceRegistry: surface(),
    world: world(),
    worldInstanceId: "composition-run-world",
  });

  assert.equal(composition.boundGrants[0]?.principal, "agent:alpha");
  assert.equal(
    composition.manifestsByParticipant.alpha?.holder.principal,
    "agent:alpha",
  );
});

test("fails closed on over-broad grants and incomplete compilation output", () => {
  assert.throws(
    () => composeWorldGrants({
      runId: "composition-run",
      surfaceRegistry: surface(),
      world: world("sense:absent"),
      worldInstanceId: "composition-run-world"
    }),
    /not declared by the checked world surface/u
  );

  const complete = composeWorldGrants({
    runId: "composition-run",
    surfaceRegistry: surface(),
    world: world(),
    worldInstanceId: "composition-run-world"
  });
  assert.throws(
    () => assertWorldGrantManifestCount(complete.boundGrants, []),
    /expected 1, received 0/u
  );
});
