import assert from "node:assert/strict";
import test from "node:test";

import { parseSimfileSource } from "../schema/parse.js";
import { parseWorldSurfaceDefinition } from "../world-surface/index.js";
import { validWorldSurface } from "../world-surface/definition.test-helper.js";
import {
  bindWorldGrantPrincipals,
  bindWorldGrants,
  resolveWorldGrants,
  type WorldGrantPrincipalResolver
} from "./index.js";

const worldFrom = (grants: string) => parseSimfileSource(`
simfile_version: "0.1"
name: grants-test
clock:
  seed: grants-test
  tick: 1s
world:
  id: pitch
  grants:
${grants}`).simfile.world!;

const surface = () => parseWorldSurfaceDefinition(validWorldSurface());

const resolver = (entries: Readonly<Record<string, string>>): WorldGrantPrincipalResolver => ({
  resolvePrincipal: (participant) => entries[participant],
  resolveParticipant: (principal) => Object.entries(entries)
    .find(([, candidate]) => candidate === principal)?.[0]
});

test("resolves declared local grants without an organization resolver", () => {
  const world = worldFrom(`
    red:
      entity: entity:red
      senses: [sense:vision]
      affordances: [affordance:kick]
    blue:
      entity: entity:ball
`);
  const grants = resolveWorldGrants(world, surface());

  assert.deepEqual(grants, [{
    participant: "blue",
    entity: "world://pitch/entity/ball",
    senses: [],
    affordances: []
  }, {
    participant: "red",
    entity: "world://pitch/entity/red",
    senses: ["world://pitch/sense/vision"],
    affordances: ["world://pitch/affordance/kick"]
  }]);
  assert.ok(Object.isFrozen(grants));
  assert.ok(Object.isFrozen(grants[0]));
  assert.ok(Object.isFrozen(grants[1]!.senses));
  assert.throws(() => (grants as unknown as unknown[]).push({}), TypeError);
  assert.throws(() => (grants[1]!.senses as unknown as string[]).push("world://pitch/sense/other"), TypeError);
  assert.ok(grants.flatMap((grant) => [grant.entity, ...grant.senses, ...grant.affordances])
    .every((address) => address.startsWith("world://pitch/")));

  const mutableWorld = {
    ...world,
    grants: { red: { ...world.grants.red!, senses: ["sense:vision"], affordances: [] } }
  } as unknown as { grants: { red: { senses: string[] } } };
  const isolated = resolveWorldGrants(mutableWorld as never, surface());
  mutableWorld.grants.red.senses.push("sense:missing");
  assert.deepEqual(isolated[0]!.senses, ["world://pitch/sense/vision"]);
});

test("rejects undeclared resources and never treats effects as grantable", () => {
  for (const grants of [
    `    red:\n      entity: entity:missing`,
    `    red:\n      entity: entity:red\n      senses: [sense:missing]`,
    `    red:\n      entity: entity:red\n      affordances: [affordance:missing]`
  ]) assert.throws(() => resolveWorldGrants(worldFrom(grants), surface()), /not declared/u);

  const world = worldFrom(`
    red:
      entity: entity:red
`);
  const grants = resolveWorldGrants(world, surface());
  assert.deepEqual(grants[0], {
    participant: "red",
    entity: "world://pitch/entity/red",
    senses: [],
    affordances: []
  });
  for (const field of ["senses", "affordances"]) {
    assert.throws(() => resolveWorldGrants({
      ...world,
      grants: { red: { ...world.grants.red!, [field]: ["effect:impact"] } }
    } as never, surface()), /local (sense|affordance): reference/u);
  }
});

test("rejects hostile canonical, cross-world, wrong-kind, and duplicate grants at resolution", () => {
  const world = worldFrom(`
    red:
      entity: entity:red
      senses: [sense:vision]
      affordances: [affordance:kick]
`);
  for (const mutation of [
    { entity: "world://other/entity/red" },
    { entity: "world://pitch/entity/red" },
    { entity: "sense:vision" },
    { senses: ["sense:vision", "sense:vision"] },
    { affordances: ["affordance:kick", "affordance:kick"] }
  ]) {
    assert.throws(() => resolveWorldGrants({
      ...world,
      grants: { red: { ...world.grants.red!, ...mutation } }
    } as never, surface()));
  }

  assert.throws(() => resolveWorldGrants({
    ...world,
    grants: { " red ": world.grants.red! }
  } as never, surface()), /expected lowercase identifier/u);
});

test("binds grants only through a one-to-one, round-trippable principal mapping", () => {
  const grants = resolveWorldGrants(worldFrom(`
    red:
      entity: entity:red
    blue:
      entity: entity:ball
`), surface());
  const bound = bindWorldGrants(grants, resolver({ blue: "principal-blue", red: "principal-red" }));
  assert.deepEqual(bound.map(({ participant, principal }) => ({ participant, principal })), [
    { participant: "blue", principal: "principal-blue" },
    { participant: "red", principal: "principal-red" }
  ]);
  assert.ok(Object.isFrozen(bound));
  assert.ok(Object.isFrozen(bound[0]!.affordances));

  assert.throws(() => bindWorldGrants(grants, resolver({ red: "principal-red" })), /has no principal/u);
  assert.throws(() => bindWorldGrants(grants, resolver({
    blue: "principal-shared", red: "principal-shared"
  })), /bound more than once/u);
  assert.throws(() => bindWorldGrants(grants, {
    resolvePrincipal: (participant) => participant === "red" ? "principal-blue" : "principal-red",
    resolveParticipant: () => "blue"
  }), /does not round-trip/u);
  assert.throws(() => bindWorldGrants(grants, {
    resolvePrincipal: () => "",
    resolveParticipant: () => "red"
  }), /has no principal/u);
  assert.throws(() => bindWorldGrants(grants, {
    resolvePrincipal: () => "   ",
    resolveParticipant: () => "red"
  }), /has no principal/u);
  assert.throws(() => bindWorldGrantPrincipals(grants, {
    resolvePrincipal: () => " principal-red ",
    resolveParticipant: () => "red"
  }), /has no principal/u);
});
