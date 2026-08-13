import assert from "node:assert/strict";
import test from "node:test";

import { parseSimfileSource } from "./parse.js";

const sourceFor = (world: string): string => `
simfile_version: "0.1"
name: grant-world
clock:
  seed: schema-test
  tick: 1s
${world}`;

test("parses generic world grants and freezes omitted grant classes", () => {
  const { simfile } = parseSimfileSource(sourceFor(`
world:
  id: pitch
  grants:
    red:
      entity: entity:red
      senses: [sense:player-view]
    blue:
      entity: entity:blue
      affordances: [affordance:move]
`));

  assert.deepEqual(simfile.world, {
    id: "pitch",
    grants: {
      red: {
        entity: "entity:red",
        senses: ["sense:player-view"],
        affordances: []
      },
      blue: {
        entity: "entity:blue",
        senses: [],
        affordances: ["affordance:move"]
      }
    }
  });
  assert.ok(Object.isFrozen(simfile.world));
  assert.ok(Object.isFrozen(simfile.world!.grants.red!.senses));
  assert.ok(Object.isFrozen(simfile.world!.grants.blue!.affordances));
  assert.throws(
    () => (simfile.world!.grants.red!.senses as unknown as string[]).push("sense:ball-state"),
    TypeError
  );
});

test("preserves Simfiles that do not author a world", () => {
  const { simfile } = parseSimfileSource(sourceFor(""));
  assert.equal(simfile.world, undefined);
});

test("rejects invalid world ids, participant keys, and missing entities", () => {
  for (const world of [
    `world:\n  id: world://pitch\n  grants: {}`,
    `world:\n  id: pitch/other\n  grants: {}`,
    `world:\n  id: pitch\n  grants:\n    Red:\n      entity: entity:red`,
    `world:\n  id: pitch\n  grants:\n    red: {}`
  ]) {
    assert.throws(() => parseSimfileSource(sourceFor(world)));
  }
});

test("rejects nonlocal, wrong-kind, and hostile resource references during parsing", () => {
  const hostile = [
    "world://pitch/entity/red",
    "https://example.test/entity/red",
    "entity:red/blue",
    "entity:red?next=blue",
    "entity:red#blue",
    "entity:red%2fblue",
    "entity:red\\blue",
    "entity:red\u0000blue",
    "sense:red"
  ];
  for (const reference of hostile) {
    const escaped = JSON.stringify(reference);
    assert.throws(() => parseSimfileSource(sourceFor(`
world:
  id: pitch
  grants:
    red:
      entity: ${escaped}
`)));
  }

  for (const [field, reference] of [
    ["senses", "effect:goal"],
    ["senses", "affordance:move"],
    ["affordances", "effect:goal"],
    ["affordances", "sense:player-view"]
  ]) {
    assert.throws(() => parseSimfileSource(sourceFor(`
world:
  id: pitch
  grants:
    red:
      entity: entity:red
      ${field}: [${reference}]
`)));
  }
});

test("rejects duplicate senses and affordances", () => {
  for (const field of ["senses", "affordances"]) {
    const reference = field === "senses" ? "sense:player-view" : "affordance:move";
    assert.throws(() => parseSimfileSource(sourceFor(`
world:
  id: pitch
  grants:
    red:
      entity: entity:red
      ${field}: [${reference}, ${reference}]
`)));
  }
});
