import assert from "node:assert/strict";
import test from "node:test";

import {
  runComposedFailureCleanup,
  throwAfterComposedFailureCleanup,
} from "./composedFailureCleanup.js";

test("composed failure cleanup attempts every step and aggregates failures", async () => {
  const calls: string[] = [];
  const primary = new Error("primary failure");
  await assert.rejects(throwAfterComposedFailureCleanup(primary, [
    { label: "first", run: async () => { calls.push("first"); throw new Error("one"); } },
    { label: "second", run: async () => { calls.push("second"); } },
    { label: "third", run: async () => { calls.push("third"); throw new Error("three"); } },
  ]), (error) => {
    assert.ok(error instanceof AggregateError);
    assert.equal(error.errors[0], primary);
    assert.equal(error.errors.length, 3);
    return true;
  });
  assert.deepEqual(calls, ["first", "second", "third"]);
});

test("successful cleanup rethrows the original failure by identity", async () => {
  const primary = new Error("primary failure");
  await assert.rejects(throwAfterComposedFailureCleanup(primary, [
    { label: "only", run: async () => undefined },
  ]), (error) => error === primary);
  assert.deepEqual(await runComposedFailureCleanup([]), []);
});
