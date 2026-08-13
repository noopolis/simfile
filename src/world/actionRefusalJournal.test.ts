import assert from "node:assert/strict";
import test from "node:test";

import {
  createWorldActionRefusalJournal,
} from "./actionRefusalJournal.js";
import {
  readWorldRuntimeActionRefusalJournalInspection,
} from "./actionJournalInspection.js";
import {
  runtimeActEnvelope,
  runtimeFixtureWithHooks,
} from "./runtime.test-helper.js";

const journal = (capacity = 4) => createWorldActionRefusalJournal({
  capacity,
  principals: ["principal-red"],
  readTick: () => 7,
});

test("the record-time choke point degrades forged rejection detail", () => {
  const refusals = journal();
  assert.deepEqual(
    refusals.refuse("principal-red", "forged_reason", "force"),
    {
      disposition: "rejected_at_ingress",
      code: "world_action_denied",
      reason: "internal_error",
    },
  );
  assert.deepEqual(refusals.read(0), [{
    ordinal: 1,
    refusal: {
      at_tick: 7,
      principal: "principal-red",
      reason: "internal_error",
    },
  }]);
  assert.equal("field_path" in refusals.read(0)[0]!.refusal, false);
});

test("bounded refusal retention surfaces every overwritten ordinal", () => {
  const refusals = journal(2);
  refusals.refuse("principal-red", "request_malformed");
  refusals.refuse("principal-red", "affordance_not_granted");
  refusals.refuse("principal-red", "target_not_granted");

  assert.throws(
    () => refusals.read(0),
    /world action refusal evidence overflow through ordinal 1/u,
  );
  assert.deepEqual(
    refusals.read(1).map(({ ordinal, refusal }) => [ordinal, refusal.reason]),
    [[2, "affordance_not_granted"], [3, "target_not_granted"]],
  );
  refusals.acknowledge(3);
  assert.deepEqual(refusals.read(3), []);
});

test("refusal recording falls back to the last real host tick without throwing", () => {
  let mode: "valid" | "invalid" | "throw" = "valid";
  const refusals = createWorldActionRefusalJournal({
    principals: ["principal-red"],
    readTick: () => {
      if (mode === "throw") throw new Error("tick unavailable");
      return mode === "invalid" ? Number.NaN : 11;
    },
  });
  mode = "invalid";
  assert.doesNotThrow(() =>
    refusals.refuse("principal-red", "affordance_not_granted"));
  mode = "throw";
  assert.doesNotThrow(() =>
    refusals.refuse("principal-red", "target_not_granted"));
  assert.deepEqual(
    refusals.read(0).map(({ refusal }) => refusal.at_tick),
    [11, 11],
  );
});

test("runtime act returns and retains refusal after checked-session rollback closure", () => {
  const fixture = runtimeFixtureWithHooks({
    failRestore: () => true,
    available: () => true,
    lower: (input) => ({
      force: (input as { input: { force: number } }).input.force,
    }),
    observe: (input, state) => {
      state.value = Number(state.value) + 1;
      return {
        channels: (input as { sense_addresses: readonly string[] })
          .sense_addresses.map((senseAddress) => ({
            components: { x: 1 },
            sense_address: senseAddress,
            subject_address: "object:red",
            unit: "meters",
          })),
      };
    },
  });
  const runtime = fixture.runtime;
  assert.ok(runtime);
  const port = readWorldRuntimeActionRefusalJournalInspection(runtime);
  assert.ok(port);
  let receipt: ReturnType<typeof runtime.act> | undefined;
  assert.doesNotThrow(() => {
    receipt = runtime.act(
      { principal: "principal-red", decisionToken: fixture.red.token },
      runtimeActEnvelope("rollback-closed-refusal", {
        affordance: "world://pitch/affordance/kick",
        target: "world://pitch/entity/ball",
        input: { force: 0.5 },
      }),
    );
  });
  assert.deepEqual(receipt, {
    disposition: "rejected_at_ingress",
    code: "world_action_denied",
    reason: "world_surface_failed",
  });
  assert.deepEqual(port.read(0), [{
    ordinal: 1,
    refusal: {
      at_tick: 0,
      principal: "principal-red",
      reason: "world_surface_failed",
    },
  }]);
});

test("runtime inspection is exact-runtime, drain-only, and omits unknown principals", () => {
  const fixture = runtimeFixtureWithHooks({});
  const runtime = fixture.runtime;
  assert.ok(runtime);
  const port = readWorldRuntimeActionRefusalJournalInspection(runtime);
  assert.ok(port);
  assert.equal(readWorldRuntimeActionRefusalJournalInspection({ ...runtime }), undefined);
  assert.deepEqual(Object.keys(port), ["acknowledge", "read"]);
  assert.equal("refuse" in port, false);

  const receipt = runtime.act(
    { principal: "uncomposed-bearer", decisionToken: fixture.red.token },
    runtimeActEnvelope("unknown-principal", {
      affordance: "world://pitch/affordance/kick",
      target: "world://pitch/entity/ball",
      input: { force: 1 },
    }),
  );
  assert.equal(receipt.disposition, "rejected_at_ingress");
  assert.deepEqual(port.read(0), [{
    ordinal: 1,
    refusal: { at_tick: 0, reason: "principal_unknown" },
  }]);
  assert.equal("principal" in port.read(0)[0]!.refusal, false);
});
