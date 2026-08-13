import assert from "node:assert/strict";
import test from "node:test";

import {
  compileReportMemberEngines,
  compileReportMoltnetReleaseExpectation,
  deriveCompiledOrganizationArtifactDigest,
  parseSpawnfileCompileReport,
} from "./compiledOrganizationIdentity.js";

const release = {
  architecture: "amd64",
  asset: "moltnet_linux_amd64.tar.gz",
  asset_sha256: `sha256:${"a".repeat(64)}`,
  capabilities: ["pi-bridge"],
  release_version: "v0.1.0",
  source_revision: "b".repeat(40),
  version: "spawnfile.moltnet-release-identity.v1",
} as const;

const report = (fingerprint: string, engines: readonly Readonly<Record<string, string>>[]) => ({
  compile_fingerprint: fingerprint,
  container: {
    moltnet: { release },
    runtime_instances: engines.map((engine_by_node_id) => ({ engine_by_node_id })),
  },
});

test("keeps Spawnfile compile fingerprints distinct from composed artifact digests", () => {
  const parsed = parseSpawnfileCompileReport(report("sf1:0123456789ab", [{
    "agent:blue": "pi",
  }]));
  const artifact = deriveCompiledOrganizationArtifactDigest(parsed.compile_fingerprint);
  assert.match(parsed.compile_fingerprint, /^sf1:[a-f0-9]{12}$/u);
  assert.equal(artifact,
    "sha256:bed587cd84d207b29c02c2ef80f519d1849a59cff1b2d28c4ce2e0a645f7a8e5");
  assert.equal(artifact, deriveCompiledOrganizationArtifactDigest(parsed.compile_fingerprint));
  assert.throws(() => parseSpawnfileCompileReport(report(`sha256:${"c".repeat(64)}`, [{
    "agent:blue": "pi",
  }])));
});

test("requires one consistent engine assignment per compiled member", () => {
  const parsed = parseSpawnfileCompileReport(report("sf1:0123456789ab", [
    { "agent:blue": "pi" }, { "agent:blue": "pi", "agent:red": "pi" },
  ]));
  assert.deepEqual(compileReportMemberEngines(parsed), {
    "agent:blue": "pi", "agent:red": "pi",
  });
  const contradictory = parseSpawnfileCompileReport(report("sf1:0123456789ab", [
    { "agent:blue": "pi" }, { "agent:blue": "other" },
  ]));
  assert.throws(() => compileReportMemberEngines(contradictory), /contradictory/u);
});

test("projects the public Moltnet identity onto the strict lifecycle expectation", () => {
  const parsed = parseSpawnfileCompileReport(report("sf1:0123456789ab", [{
    "agent:blue": "pi",
  }]));
  assert.deepEqual(compileReportMoltnetReleaseExpectation(parsed), {
    architecture: "amd64",
    asset_sha256: `sha256:${"a".repeat(64)}`,
    release_version: "v0.1.0",
    source_revision: "b".repeat(40),
  });
});
