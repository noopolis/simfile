import assert from "node:assert/strict";
import test from "node:test";

import {
  parseSpawnfileLifecycleLookup,
  resolveSpawnfileLifecycleOutcome,
} from "./lifecycleLookup.js";

const id = "lci_aaaaaaaaaaaaaaaa";
const digest = `sha256:${"1".repeat(64)}`;
const input = { invocation_id: id, operation: "up" as const };

test("lifecycle lookup parses every exact typed state", () => {
  assert.deepEqual(parseSpawnfileLifecycleLookup({ invocation_id: id,
    status: "not_applied", version: "spawnfile.lifecycle-lookup.v1" }, input), {
    invocation_id: id, status: "not_applied",
  });
  assert.equal(parseSpawnfileLifecycleLookup({ invocation_digest: digest,
    operation: "up", status: "pending",
    version: "spawnfile.lifecycle-lookup.v1" }, input).status, "pending");
  assert.equal(parseSpawnfileLifecycleLookup({ invocation_digest: digest,
    operation: "up", reason_code: "recovery_owner_died", status: "ambiguous",
    version: "spawnfile.lifecycle-lookup.v1" }, input).status, "ambiguous");
  assert.deepEqual(parseSpawnfileLifecycleLookup({ invocation_digest: digest,
    operation: "up", outcome_bytes: "{\"ok\":true}", status: "completed",
    version: "spawnfile.lifecycle-lookup.v1" }, input), {
    invocation_digest: digest, operation: "up", outcome: { ok: true }, status: "completed",
  });
});

test("lifecycle resolution invokes only a typed not-applied operation", async () => {
  let invoked = 0;
  const result = await resolveSpawnfileLifecycleOutcome<unknown>({ ...input,
    invoke: async () => { invoked += 1; return { fresh: true }; },
    lookup: async () => ({ invocation_id: id, status: "not_applied" }),
    parse: (raw) => raw as { fresh: boolean },
  });
  assert.deepEqual(result, { fresh: true });
  assert.equal(invoked, 1);
  const completed = await resolveSpawnfileLifecycleOutcome<unknown>({ ...input,
    invoke: async () => { invoked += 1; return { fresh: true }; },
    lookup: async () => ({ invocation_digest: digest as `sha256:${string}`,
      operation: "up", outcome: { recovered: true }, status: "completed" }),
    parse: (raw) => raw as { recovered: boolean },
  });
  assert.deepEqual(completed, { recovered: true });
  assert.equal(invoked, 1);
});

test("lifecycle resolution fails closed on pending and ambiguous states", async () => {
  const base = { ...input, invoke: async () => ({}), parse: (raw: unknown) => raw };
  await assert.rejects(resolveSpawnfileLifecycleOutcome({ ...base,
    lookup: async () => ({ invocation_digest: digest as `sha256:${string}`,
      operation: "up", status: "pending" }) }), /remains pending/u);
  await assert.rejects(resolveSpawnfileLifecycleOutcome({ ...base,
    lookup: async () => ({ invocation_digest: digest as `sha256:${string}`,
      operation: "up", reason_code: "reconciliation_ambiguous",
      status: "ambiguous" }) }), /is ambiguous/u);
});
