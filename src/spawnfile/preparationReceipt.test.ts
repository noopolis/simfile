import assert from "node:assert/strict";
import test from "node:test";

import {
  parseSpawnfileComposedPreparationReceipt,
  verifySpawnfileComposedPreparationReceipt,
} from "./preparationReceipt.js";
import {
  composedPreparationReceiptFixture,
  composedPreparationRequestFixture,
} from "./preparationReceipt.test-helper.js";

const request = composedPreparationRequestFixture();

test("preparation parser tolerates additive fields while enforcing exact identity", () => {
  const receipt = composedPreparationReceiptFixture();
  assert.deepEqual(parseSpawnfileComposedPreparationReceipt(receipt), receipt);
  assert.deepEqual(verifySpawnfileComposedPreparationReceipt({ receipt, request }), receipt);
});

test("preparation parser rejects digest, correlation, cross-run, and secret-shaped forgeries", () => {
  const receipt = composedPreparationReceiptFixture();
  assert.throws(() => parseSpawnfileComposedPreparationReceipt({ ...receipt, run_id: "run-foreign" }), /digest/u);
  assert.throws(() => parseSpawnfileComposedPreparationReceipt({
    ...receipt,
    resources: {
      ...receipt.resources,
      world_artifact: { ...receipt.resources.world_artifact, resulting_revision: 4 },
    },
  }), /digest/u);
  assert.throws(() => verifySpawnfileComposedPreparationReceipt({
    receipt,
    request: { ...request, target_selector: "other-target" },
  }), /correlation/u);
  assert.throws(() => parseSpawnfileComposedPreparationReceipt({
    ...receipt,
    token: "sk-abcdefghijklmnop",
  }), /secret-shaped/u);
});
