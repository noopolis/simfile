import assert from "node:assert/strict";
import test from "node:test";

import { parseSpawnfileLocalEndpointProof } from "./spawnfile-local-endpoint.mjs";

const receipt = {
  base_image: { config_digest: `sha256:${"1".repeat(64)}`, reference: "node:22" },
  context_selection: "explicit",
  endpoint: { class: "local", transport: "unix" },
  platform: { architecture: "amd64", os: "linux" },
  target_config: { context: "local_dev", version: "spawnfile.target-default-config.v1" },
  target_config_digest: `sha256:${"2".repeat(64)}`,
  version: "spawnfile.target-config-resolution.v1",
};

test("local endpoint proof binds exact context and rejects remote classification", () => {
  assert.deepEqual(parseSpawnfileLocalEndpointProof(receipt, "local_dev"), {
    architecture: "amd64", context: "local_dev", endpoint_class: "local",
    transport: "unix", version: "simfile.spawnfile-local-endpoint-proof.v1",
  });
  for (const forged of [
    { ...receipt, endpoint: { class: "remote", transport: "unix" } },
    { ...receipt, target_config: { ...receipt.target_config, context: "other" } },
    { ...receipt, context_selection: "default" },
  ]) assert.throws(() => parseSpawnfileLocalEndpointProof(forged, "local_dev"),
    /local endpoint/u);
});
