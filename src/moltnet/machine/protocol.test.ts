import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";

import { decodeMoltnetMachineTerminal, encodeMoltnetMachineRequest } from "./protocol.js";
import { MOLTNET_MACHINE_CONTRACT_SHA256, MoltnetMachineError } from "./types.js";

const send = (extra = "") => `{"version":"moltnet.machine.v1","correlation_id":"send_1","operation":"send_nudge","send_nudge":{"message_id":"message_1","event_id":"event_1","accepted":true,"thread_created":false,"dm_created":false${extra}}}`;
const sha256 = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");

const GOLDEN_HASHES = Object.freeze({
  contract: "1ed6bdc3a9600fd5fc55052d4ba20d1c3d13a7e37daf0465b4543ff5bc5cc64d",
  send_nudge_request: "b91e932007623375878d5c229521c9f6d9f069d843ff505280b9f4132efaf6b4",
  read_request: "995ae29cae52959ec3cd9dc23af5f5372fdde5a191007e9e01aee7d3f46a98d0",
  cancel_request: "243b527b184b44ee9b13a1391aa03067e8ca0255e0dc8fa03d1fce706e535ae4",
  send_nudge_success: "061143f0a26c5dc2ec3f3d5a781dfa08e754ec9760ec1c40a3aa11f42fa933ec",
  read_success_empty: "b4facf0071da6b1b695aee379477c22356cf53a6ee06f53dabb6deb36f368998",
  read_success_nonempty_with_after: "1cf6b11be03b57dcfb921228fdf3f7a6bc9acb0cef427bd45afa227d66d4d9aa",
  read_success_nonempty_with_before: "2c09baa66b91d07639e78863a3a8d7853cd3e53480973d35d00ebed8ab40af61",
  cancel_success: "0a125231cbe05fc8d7fda1d5fa55cb98665fe5d032e15ece34ecee3d06886c28",
  cancel_already_final: "0a204b6226408eb4a5b57df2caeb8b0728b41fbc96e0b6ad1d71bd9ac703f447",
  cancel_not_found: "ed7433cd8c925257bd66649c6a649d0e55d5534db10482575a07fd8fddc4efe1",
});

describe("moltnet machine protocol", () => {
  it("encodes only the frozen enabled request shape", () => {
    assert.equal(encodeMoltnetMachineRequest({
      version: "moltnet.machine.v1", correlation_id: "read_1", operation: "read",
      read: { target: { kind: "room", id: "room_1" }, limit: 1 }
    }), "{\"version\":\"moltnet.machine.v1\",\"correlation_id\":\"read_1\",\"operation\":\"read\",\"read\":{\"target\":{\"kind\":\"room\",\"id\":\"room_1\"},\"limit\":1}}");
  });

  it("enforces the provider's UTF-8 body limit", () => {
    const request = {
      version: "moltnet.machine.v1" as const, correlation_id: "send_1", operation: "send_nudge" as const,
      send_nudge: { delivery_id: "delivery_1", target: { kind: "dm" as const, id: "peer_1" }, body: "é".repeat(1_025) }
    };
    assert.throws(() => encodeMoltnetMachineRequest(request), MoltnetMachineError);
    assert.throws(() => encodeMoltnetMachineRequest({
      ...request, send_nudge: { ...request.send_nudge, body: " \t " }
    }), MoltnetMachineError);
  });

  it("rejects version drift, excess payloads, and duplicate delivery causes", () => {
    const valid = {
      version: "moltnet.machine.v1" as const, correlation_id: "send_1", operation: "send_nudge" as const,
      send_nudge: { delivery_id: "delivery_1", target: { kind: "dm" as const, id: "peer_1" }, body: "wake" }
    };
    assert.throws(() => encodeMoltnetMachineRequest({ ...valid, version: "moltnet.machine.v2" } as never), MoltnetMachineError);
    assert.throws(() => encodeMoltnetMachineRequest({ ...valid, read: { target: { kind: "dm", id: "peer_1" }, limit: 1 } } as never), MoltnetMachineError);
    assert.throws(() => encodeMoltnetMachineRequest({ ...valid, send_nudge: { ...valid.send_nudge, cause_event_ids: ["cause_1", "cause_1"] } }), MoltnetMachineError);
  });

  it("pins the reviewed provider contract and enabled golden vectors", () => {
    assert.equal(MOLTNET_MACHINE_CONTRACT_SHA256, GOLDEN_HASHES.contract);
    const requests = [
      ["send_nudge_request", { version: "moltnet.machine.v1", correlation_id: "corr_send_1", operation: "send_nudge", send_nudge: { delivery_id: "delivery_1", target: { kind: "room", id: "room_1" }, body: "wake for nudge", origin_message_id: "origin_1", cause_event_ids: ["ev_1", "ev_2"] } }],
      ["read_request", { version: "moltnet.machine.v1", correlation_id: "corr_read_1", operation: "read", read: { target: { kind: "room", id: "room_1" }, limit: 20, after: "msg_1" } }],
      ["cancel_request", { version: "moltnet.machine.v1", correlation_id: "corr_can_1", operation: "cancel", cancel: { target_correlation_id: "corr_read_1" } }],
    ] as const;
    for (const [name, request] of requests) assert.equal(sha256(encodeMoltnetMachineRequest(request)), GOLDEN_HASHES[name]);
    const terminals = [
      ["send_nudge_success", `{"version":"moltnet.machine.v1","correlation_id":"corr_send_1","operation":"send_nudge","send_nudge":{"message_id":"message_1","event_id":"event_1","accepted":true,"thread_id":"thread_1","thread_created":true,"dm_created":false}}`],
      ["read_success_empty", `{"version":"moltnet.machine.v1","correlation_id":"corr_read_3","operation":"read","read":{"target":{"kind":"room","id":"room_1"},"page":{"messages":null,"page":{"has_more":false}}}}`],
      ["read_success_nonempty_with_after", `{"version":"moltnet.machine.v1","correlation_id":"corr_read_1","operation":"read","read":{"target":{"kind":"room","id":"room_1"},"page":{"messages":[{"id":"msg_2","network_id":"net_1","origin":{"network_id":"net_1","message_id":"msg_1"},"target":{"kind":"room","room_id":"room_1"},"from":{"type":"agent","id":"agent_1"},"parts":[{"kind":"text","text":"hello"}],"mentions":["agent_2"],"created_at":"2026-07-21T00:00:00Z"}],"page":{"has_more":true,"next_after":"msg_3"}}}}`],
      ["read_success_nonempty_with_before", `{"version":"moltnet.machine.v1","correlation_id":"corr_read_2","operation":"read","read":{"target":{"kind":"room","id":"room_1"},"page":{"messages":[{"id":"msg_2","network_id":"net_1","origin":{"network_id":"net_1","message_id":"msg_1"},"target":{"kind":"room","room_id":"room_1"},"from":{"type":"agent","id":"agent_1"},"parts":[{"kind":"text","text":"hello"}],"mentions":["agent_2"],"created_at":"2026-07-21T00:00:00Z"}],"page":{"has_more":true,"next_before":"msg_1"}}}}`],
      ["cancel_success", `{"version":"moltnet.machine.v1","correlation_id":"corr_can_1","operation":"cancel","cancel":{"target_correlation_id":"corr_read_1","state":"canceled"}}`],
      ["cancel_already_final", `{"version":"moltnet.machine.v1","correlation_id":"corr_can_2","operation":"cancel","cancel":{"target_correlation_id":"corr_read_1","state":"already_final"}}`],
      ["cancel_not_found", `{"version":"moltnet.machine.v1","correlation_id":"corr_can_3","operation":"cancel","cancel":{"target_correlation_id":"corr_read_1","state":"not_found"}}`],
    ] as const;
    for (const [name, line] of terminals) {
      assert.equal(sha256(line), GOLDEN_HASHES[name]);
      assert.doesNotThrow(() => decodeMoltnetMachineTerminal(line));
    }
  });

  for (const [name, line] of [
    ["unknown", send(',"unknown":"x"')],
    ["duplicate", `{"version":"moltnet.machine.v1","correlation_id":"send_1","operation":"send_nudge","send_nudge":{"message_id":"message_1","message_id":"message_2","event_id":"event_1","accepted":true,"thread_created":false,"dm_created":false}}`],
    ["version", send().replace("moltnet.machine.v1", "moltnet.machine.v2")],
    ["nonterminal", `{"version":"moltnet.machine.v1","correlation_id":"sub_1","operation":"subscribe","event":{"event_id":"event_1","type":"message","payload":{}}}`],
    ["oversized", `${send()}${" ".repeat(16_384)}`]
  ] as const) {
    it(`rejects ${name} machine output`, () => assert.throws(() => decodeMoltnetMachineTerminal(line), MoltnetMachineError));
  }

  it("accepts an exact send terminal", () => {
    assert.equal(decodeMoltnetMachineTerminal(send()).send_nudge?.message_id, "message_1");
  });

  it("rejects hostile nested read values and locks enabled error terminals", () => {
    const baseline = `{"version":"moltnet.machine.v1","correlation_id":"corr_read_1","operation":"read","read":{"target":{"kind":"room","id":"room_1"},"page":{"messages":[{"id":"msg_1","network_id":"net_1","origin":{"network_id":"net_1","message_id":"origin_1"},"target":{"kind":"room","room_id":"room_1"},"from":{"type":"agent","id":"agent_1"},"parts":[{"kind":"text","text":"hello"}],"created_at":"2026-07-21T00:00:00Z"}],"page":{"has_more":false}}}}`;
    for (const hostile of [
      baseline.replace('"room_id":"room_1"', '"room_id":"room_1","dm_id":"dm_1"'),
      baseline.replace('"kind":"text"', '"kind":"unknown"'),
      baseline.replace('"text":"hello"', '"url":"ftp://host"'),
      baseline.replace('"text":"hello"', `"data":{"x":"${"x".repeat(8_193)}"}`),
      baseline.replace('"id":"agent_1"', '"id":"bad member"'),
      baseline.replace('"id":"agent_1"', '"id":"net_1/agent_1"'),
      baseline.replace('"id":"agent_1"', '"id":"net::agent"')
    ]) assert.throws(() => decodeMoltnetMachineTerminal(hostile), MoltnetMachineError);

    const errors = [
      ["invalid_request", "corr_err_1", "4e50530254a1c333e68f2f48a47fb49380a69e011c6b20bc5a4dd7542611b15a"],
      ["duplicate_request", "corr_err_2", "38ae4836cbc0f504894166738af6b82fd59df9764fd76658fc917e2b4b05cbc5"],
      ["not_found", "corr_err_3", "09e2fa7166c49fdc9194ae2647fc517f801aba346f95b40ba84338b6bdc12f5d"],
      ["conflict", "corr_err_4", "348e213bfa2b8f16efbeb36be0b39844464db0470a86d53acd4a1e781715e24e"],
      ["capacity", "corr_err_5", "e1d1a2a982de46da8b1101c1cee0e487008a8ef75c1e8b6a4491511836317042"],
      ["transport", "corr_err_6", "937ad520f1d374230278302ed73a717d22b16b7041af834e61da26155190477a"],
      ["canceled", "corr_err_7", "62037cefb5dc34f8ec7959339f4fa78d3ac166b7c27f0cbd84b5ec22b2409409"]
    ] as const;
    for (const [code, correlation, hash] of errors) {
      const line = `{"version":"moltnet.machine.v1","correlation_id":"${correlation}","operation":"send_nudge","error":{"code":"${code}"}}`;
      assert.equal(sha256(line), hash);
      assert.doesNotThrow(() => decodeMoltnetMachineTerminal(line));
    }

    for (const accepted of [
      baseline.replace('"id":"agent_1"', '"id":"net_1:agent_1"'),
      baseline.replace('"id":"agent_1"', `"id":"${"n".repeat(128)}:${"a".repeat(128)}"`),
      baseline.replace('"id":"agent_1"', '"id":"molt://net_1/agents/agent_1"'),
      baseline.replace('"id":"agent_1"', '"id":"agent_1","credential_bound":true'),
      baseline.replace("2026-07-21T00:00:00Z", "2026-07-21T02:00:00+02:00")
    ]) assert.doesNotThrow(() => decodeMoltnetMachineTerminal(accepted));
  });
});
