import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { createLocalExampleInvocation } from "./simfile-local-example.mjs";

test("local example uses the canonical project and a unique bounded output", () => {
  const first = createLocalExampleInvocation("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");
  const second = createLocalExampleInvocation("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb");
  assert.notEqual(first.run_id, second.run_id);
  assert.notEqual(first.out, second.out);
  assert.equal(first.args.includes("--local"), true);
  assert.deepEqual(first.args.slice(first.args.indexOf("--ticks"), -4), ["--ticks", "12"]);
  assert.equal(first.args[2]?.endsWith(path.join("examples", "jungian-dialogue", "Simfile")),
    true);
  assert.throws(() => createLocalExampleInvocation("../escape"), /nonce is invalid/u);
});
