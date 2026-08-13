import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { stableStringify } from "../ledger/stable.js";
import { deriveComposedLiveEvidence } from "./liveEvidence.js";
import { COMPOSED_ARTIFACT_ROLES, createComposedRunRecord } from "./runRecord.js";

const bytes = (value: unknown): Uint8Array => new TextEncoder().encode(`${stableStringify(value)}\n`);
const record = async (counts: Readonly<Record<string, number>>) => {
  const root = await mkdtemp(path.join(tmpdir(), "simfile-live-evidence-"));
  const out = path.join(root, "run-live");
  const writer = await createComposedRunRecord({ identity: {
    contract_versions: {}, created_at: "2026-08-07T12:00:00.000Z", run_id: "run-live",
  }, out_dir: out });
  for (const [index, role] of COMPOSED_ARTIFACT_ROLES.entries()) {
    await writer.writeArtifact({ bytes: bytes({ role }), path: `required/${role}-${index}.json`, role });
  }
  const principals = Object.keys(counts).sort().map((participant) => ({
    participant, principal: `principal:${participant}`,
  }));
  const actions = principals.flatMap(({ participant, principal }) =>
    Array.from({ length: counts[participant]! }, (_, index) => ({
      authenticated: true, disposition: "applied", participant, principal,
      receipt_id: `world-act-${participant}-${index + 1}`,
    })));
  await writer.writeArtifact({ bytes: bytes({ principals, run_id: "run-live",
    version: "simfile.composed-principals.v1" }), path: "identities/principals.json",
    role: "identity" });
  await writer.writeArtifact({ bytes: bytes({ actions, run_id: "run-live",
    version: "simfile.accepted-strategic-actions.v1" }),
    path: "raw/world/accepted-strategic-actions.json", role: "accepted-action" });
  await writer.seal();
  return out;
};

describe("post-hoc live evidence", () => {
  it("counts authenticated accepted actions for every declared principal", async () => {
    const runDir = await record({ blue: 1, red: 2 });
    const verdict = await deriveComposedLiveEvidence({
      accepted_actions_path: "raw/world/accepted-strategic-actions.json",
      principals_path: "identities/principals.json", run_dir: runDir,
    });
    assert.equal(verdict.state, "passed");
    assert.deepEqual(verdict.counts.map(({ count, participant }) => ({ count, participant })), [
      { count: 1, participant: "blue" }, { count: 2, participant: "red" },
    ]);
  });

  it("keeps a valid sealed run while failing the live-agent verdict on zero", async () => {
    const runDir = await record({ blue: 0, red: 1 });
    const verdict = await deriveComposedLiveEvidence({
      accepted_actions_path: "raw/world/accepted-strategic-actions.json",
      principals_path: "identities/principals.json", run_dir: runDir,
    });
    assert.equal(verdict.state, "failed");
    assert.deepEqual(verdict.zero_action_principals, ["principal:blue"]);
  });

  it("rejects tamper and unauthenticated or unlisted actions", async () => {
    const runDir = await record({ blue: 1 });
    await writeFile(path.join(runDir, "identities/principals.json"), "{}\n");
    await assert.rejects(deriveComposedLiveEvidence({
      accepted_actions_path: "raw/world/accepted-strategic-actions.json",
      principals_path: "identities/principals.json", run_dir: runDir,
    }), /mismatch/u);
  });
});

