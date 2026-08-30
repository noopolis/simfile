import assert from "node:assert/strict";
import test from "node:test";

import {
  createComposedSmokeInvocation,
  parseSmokeRunArguments,
} from "./spawnfile-composed-smoke.mjs";

test("composed smoke runner requires one explicit portable local target", () => {
  assert.deepEqual(parseSmokeRunArguments([
    "--context", "local-dev",
    "--out", "runs/smoke",
    "--view",
  ]), {
    baseImage: undefined,
    context: "local-dev",
    dockerCommand: undefined,
    internalLifecycleSmoke: false,
    simfileArgs: ["--out", "runs/smoke", "--view"],
  });
  assert.throws(() => parseSmokeRunArguments([]), /--context/u);
  assert.throws(() => parseSmokeRunArguments(["--context", "LOCAL"]),
    /safe-local-context/u);
  assert.throws(() => parseSmokeRunArguments([
    "--context", "local-dev", "--mode", "live",
  ]), /Unknown/u);
});

test("composed smoke runner pins its mode and unique default run output", () => {
  const first = createComposedSmokeInvocation(
    ["--context", "local-dev"], "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
  );
  const second = createComposedSmokeInvocation(
    ["--context", "local-dev"], "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
  );
  assert.equal(first.mode, "lifecycle-replay-smoke");
  assert.notEqual(first.run_id, second.run_id);
  assert.notEqual(first.out, second.out);
  assert.deepEqual(first.simfileArgs.slice(-2), ["--mode", "lifecycle-replay-smoke"]);
  assert.equal(first.command, process.execPath);
  assert.match(first.command_args[0], /[/\\]dist[/\\]cli[/\\]index[.]js$/u);
  assert.equal(first.command_args[1], "run");
  assert.match(first.command_args[2],
    /[/\\]examples[/\\]jungian-dialogue[/\\]Simfile$/u);
  assert.equal(first.example, first.command_args[2]);
  assert.deepEqual(first.command_args.slice(3), first.simfileArgs);
  const explicit = createComposedSmokeInvocation([
    "--context", "local-dev", "--run-id", "chosen", "--out", "runs/chosen",
  ], "cccccccc-cccc-cccc-cccc-cccccccccccc");
  assert.equal(explicit.run_id, "chosen");
  assert.equal(explicit.out, "runs/chosen");
});

test("the former one-agent project is only selected by the explicit internal flag", () => {
  const internal = createComposedSmokeInvocation([
    "--context", "local-dev", "--internal-lifecycle-smoke",
  ], "dddddddd-dddd-dddd-dddd-dddddddddddd");
  assert.match(internal.example,
    /[/\\]examples[/\\]composed-development[/\\]Simfile$/u);
  assert.match(internal.run_id, /^composed-lifecycle-smoke-/u);
  assert.equal(internal.internalLifecycleSmoke, true);
});
