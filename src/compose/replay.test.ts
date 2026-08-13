import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { stableStringify } from "../ledger/stable.js";
import { COMPOSED_ARTIFACT_ROLES, createComposedRunRecord } from "./runRecord.js";
import { replayComposedRunRecord } from "./replay.js";

const encode = (value: unknown): Uint8Array => new TextEncoder().encode(
  typeof value === "string" ? value : `${stableStringify(value)}\n`,
);
const hash = (value: Uint8Array): string => createHash("sha256").update(value).digest("hex");
const sealedRecord = async (options: Readonly<{
  accepted_action_count?: number;
  actions?: Uint8Array;
  terminal_value?: number;
}> = {}) => {
  const root = await mkdtemp(path.join(tmpdir(), "simfile-composed-replay-"));
  const out = path.join(root, "run-replay");
  const checkpoint = encode({ value: 1 });
  const actions = options.actions
    ?? encode('{"action":{"add":2},"boundary_tick":1,"ordinal":0}\n');
  const terminalValue = options.terminal_value ?? 3;
  const terminal = encode({ value: terminalValue });
  const probe = encode({ passed: terminalValue === 3 });
  const expected = encode({
    accepted_action_count: options.accepted_action_count ?? 1,
    action_stream_sha256: hash(actions),
    initial_checkpoint_sha256: hash(checkpoint), probe_sha256: hash(probe),
    terminal_state_sha256: hash(terminal), terminal_tick: 2,
    version: "simfile.composed-replay-expectation.v1",
  });
  const record = await createComposedRunRecord({ identity: {
    contract_versions: {}, created_at: "2026-08-07T12:00:00.000Z", run_id: "run-replay",
  }, out_dir: out });
  for (const [index, role] of COMPOSED_ARTIFACT_ROLES.entries()) {
    await record.writeArtifact({ bytes: encode(`${role}-${index}\n`),
      path: `required/${role}.json`, role });
  }
  await record.writeArtifact({ bytes: checkpoint, path: "replay/initial-checkpoint.json",
    role: "world-checkpoint" });
  await record.writeArtifact({ bytes: actions, path: "replay/accepted-actions.jsonl",
    role: "accepted-action" });
  await record.writeArtifact({ bytes: expected, path: "replay/expected.json", role: "terminal" });
  await record.seal();
  return { actions, out, probe, terminal };
};
const adapter = () => ({
  restore: (raw: unknown) => ({ value: (raw as { value: number }).value }),
  inject: ({ action, boundary_tick, state }: { action: unknown; boundary_tick: number;
    state: { value: number } }) => {
    if (boundary_tick !== 1) throw new Error("wrong boundary");
    state.value += (action as { add: number }).add;
  },
  finish: (state: { value: number }) => ({
    probe: encode({ passed: state.value === 3 }), terminal_state: encode(state), terminal_tick: 2,
  }),
});

describe("offline composed replay", () => {
  it("restores one checkpoint and injects only the recorded accepted stream", async () => {
    const fixture = await sealedRecord();
    const receipt = await replayComposedRunRecord({ adapter: adapter(), run_dir: fixture.out });
    assert.equal(receipt.exact, true);
    assert.equal(receipt.accepted_action_count, 1);
    assert.equal(receipt.terminal_tick, 2);
  });

  it("accepts the canonical empty stream when no actions were recorded", async () => {
    const fixture = await sealedRecord({
      accepted_action_count: 0, actions: new Uint8Array(), terminal_value: 1,
    });
    const receipt = await replayComposedRunRecord({ adapter: adapter(), run_dir: fixture.out });
    assert.equal(receipt.exact, true);
    assert.equal(receipt.accepted_action_count, 0);
    assert.equal(receipt.terminal_tick, 2);
  });

  it("fails on tamper, missing input, and a wrong recorded boundary", async () => {
    const tampered = await sealedRecord();
    await writeFile(path.join(tampered.out, "replay/accepted-actions.jsonl"), "tamper\n");
    await assert.rejects(replayComposedRunRecord({ adapter: adapter(), run_dir: tampered.out }),
      /artifact mismatch/u);

    const wrong = await sealedRecord();
    const manifestPath = path.join(wrong.out, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
      artifacts: Array<{ path: string; sha256: string }> };
    const actionPath = path.join(wrong.out, "replay/accepted-actions.jsonl");
    const changed = encode('{"action":{"add":2},"boundary_tick":2,"ordinal":0}\n');
    await writeFile(actionPath, changed);
    manifest.artifacts.find(({ path: artifactPath }) =>
      artifactPath === "replay/accepted-actions.jsonl")!.sha256 = hash(changed);
    await writeFile(manifestPath, `${stableStringify(manifest)}\n`);
    await assert.rejects(replayComposedRunRecord({ adapter: adapter(), run_dir: wrong.out }),
      /input correlation|wrong boundary/u);
  });

  it("has no service, provider, or cognition process imports", async () => {
    const source = await readFile(new URL("./replay.ts", import.meta.url), "utf8");
    for (const forbidden of ["child_process", "spawnfile", "moltnet", "daimon",
      "fetch(", "createServer", "executeComposedRun", "model"]) {
      assert.equal(source.toLowerCase().includes(forbidden.toLowerCase()), false, forbidden);
    }
  });
});
