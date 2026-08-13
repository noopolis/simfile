import assert from "node:assert/strict";
import test from "node:test";

import {
  createWorldSidecarProjectBinding,
  WORLD_SIDECAR_PROJECT_BINDING_VERSION,
} from "./projectBinding.js";

test("world sidecar project binding exposes only the generic build callback", async () => {
  const prepared = { archive_sha256: "fixture" };
  const binding = createWorldSidecarProjectBinding({
    prepareWorldSidecar: async () => prepared as never,
  });
  assert.equal(binding.version, WORLD_SIDECAR_PROJECT_BINDING_VERSION);
  assert.deepEqual(Object.keys(binding).sort(), ["prepareWorldSidecar", "version"]);
  assert.equal(await binding.prepareWorldSidecar({
    evidence_root: "/evidence",
    internal_port: 4070,
    secret_root: "/secrets",
  }), prepared);
  assert.equal(Object.isFrozen(binding), true);
  assert.throws(() => createWorldSidecarProjectBinding({
    prepareWorldSidecar: undefined as never,
  }), /prepare function/u);
});
