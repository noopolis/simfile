import assert from "node:assert/strict";
import test from "node:test";

import { spawnfileBundleRequestDigest } from "./containerBundleCli.js";

const digest = `sha256:${"1".repeat(64)}`;

test("bundle request digest admits the schema-bounded world archive", () => {
  const archive = Buffer.alloc(300_000).toString("base64");
  assert.match(spawnfileBundleRequestDigest({
    archive_base64: archive,
    archive_digest: digest,
    archive_entries: ["world.mjs"],
    artifact_digest: digest,
    build_policy_digest: digest,
    bundle_digest: digest,
    entrypoint: "world.mjs",
    idempotency_key: `idem_${"2".repeat(16)}`,
    launcher_digest: digest,
    network_alias: "world",
    platform: { architecture: "arm64", os: "linux" },
    platform_digest: digest,
    selected_target: {
      fingerprint: `sha256:${"3".repeat(32)}`,
      handle: `opaque_${"4".repeat(16)}`,
    },
    version: "spawnfile.target-local-container-bundle.prepare-request.v1",
  }), /^sha256:[a-f0-9]{64}$/u);
});
