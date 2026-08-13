import assert from "node:assert/strict";
import test from "node:test";

import {
  createWorldPath,
  parseLocalResourceReference,
  parseWorldId,
  resolveWorldAddress,
  resolveWorldResourceRegistry,
  type ResolvedWorldResourceEntry,
} from "./addresses.js";

test("resolves authored local references to exact canonical addresses", () => {
  const world = { id: parseWorldId("pitch") };
  const reference = parseLocalResourceReference("affordance:kick");

  assert.equal(resolveWorldAddress(world, reference), "world://pitch/affordance/kick");
});

test("preserves an explicit ordered ancestor path around a singular world id", () => {
  const world = { id: parseWorldId("match-one"), ancestors: createWorldPath("league") };

  assert.equal(
    resolveWorldAddress(world, parseLocalResourceReference("sense:player-view")),
    "world://league/match-one/sense/player-view",
  );
});

test("parses only singular portable world ids and revalidates scopes at resolution", () => {
  assert.equal(parseWorldId("pitch"), "pitch");
  for (const value of ["league/pitch", "Pitch", " pitch", "pitch ", "pitch--one", 1, null, {}]) {
    assert.throws(() => parseWorldId(value), /world id must be one portable lowercase kebab-case segment/);
  }

  const reference = parseLocalResourceReference("entity:red");
  assert.throws(() => resolveWorldAddress({ id: "pitch/other" } as never, reference), /world id/);
  assert.throws(() => resolveWorldAddress({ id: "pitch", ancestors: "league" } as never, reference), /ancestor path/);
  assert.throws(() => resolveWorldAddress({ id: "pitch", ancestors: ["League"] } as never, reference), /world id/);
});

test("rejects invalid kinds, ids, paths, and non-string local references without normalization", () => {
  for (const value of [
    "object:ball",
    "entity:",
    "entity:Red",
    "entity:red_blue",
    "entity:red--blue",
    "entity:.red",
    "entity:red/blue",
    "entity:red\\blue",
    "entity:red space",
    "entity:red:blue",
    1,
    null,
    {},
    ["entity:red"],
  ]) {
    assert.throws(() => parseLocalResourceReference(value), /local resource reference/);
  }

  assert.throws(() => createWorldPath("league", "Match-one"), /world id/);
  assert.throws(() => createWorldPath("league/match-one"), /world id/);
  assert.throws(() => createWorldPath("."), /world id/);
});

test("rejects hostile URI, encoded, absolute, query, and fragment forms", () => {
  for (const value of [
    "world://pitch/entity/red",
    "https://example.test/entity/red",
    "entity:red%2fblue",
    "entity:red%3Ablue",
    "entity:red?next=blue",
    "entity:red#blue",
    "entity:red\u0000blue",
  ]) {
    assert.throws(() => parseLocalResourceReference(value), /Invalid local resource reference/);
  }
});

test("detects duplicate canonical addresses in one world deterministically", () => {
  const world = { id: parseWorldId("pitch") };
  const red = parseLocalResourceReference("entity:red");

  assert.throws(
    () => resolveWorldResourceRegistry(world, [red, red]),
    /Canonical world address collision: world:\/\/pitch\/entity\/red/,
  );
});

test("returns a registry callers cannot mutate and isolates identical local references", () => {
  const ball = parseLocalResourceReference("entity:ball");
  const first = resolveWorldResourceRegistry({ id: parseWorldId("pitch-one") }, [ball]);
  const second = resolveWorldResourceRegistry({ id: parseWorldId("pitch-two") }, [ball]);

  assert.equal(first.entries.length, 1);
  assert.equal(second.entries.length, 1);
  assert.notEqual(first.entries[0]?.address, second.entries[0]?.address);
  assert.throws(() => (first.entries as ResolvedWorldResourceEntry[]).push(first.entries[0]!), TypeError);
  assert.throws(() => {
    (first.entries[0] as { reference: string }).reference = "entity:blue";
  }, TypeError);
  assert.equal(first.entries[0]?.reference, ball);
});
