import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parseSimfileSource } from "../schema/parse.js";
import { assertLegacyRuntimeCanExecute } from "./dynamics-guard.js";

const parse = (dynamics = "") => parseSimfileSource(`
simfile_version: "0.1"
name: guard-test
clock:
  seed: guard
  tick: 10ms
${dynamics}
`, { path: "Simfile" }).simfile;

describe("assertLegacyRuntimeCanExecute", () => {
  it("accepts worlds without a dynamics provider", () => {
    assert.doesNotThrow(() => assertLegacyRuntimeCanExecute(parse(), "legacy test"));
  });

  it("fails closed when a legacy runtime would ignore declared dynamics", () => {
    assert.throws(() => assertLegacyRuntimeCanExecute(parse(`
dynamics:
  module: ./systems/physics.mjs
`), "legacy test"), /legacy test cannot execute the declared dynamics module/u);
  });
});
