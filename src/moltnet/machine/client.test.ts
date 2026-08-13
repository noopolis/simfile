import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import { PassThrough, Writable } from "node:stream";
import { describe, it } from "node:test";

import { createMoltnetMachineClient } from "./client.js";

const script = String.raw`
let pending = new Map();
process.stdin.setEncoding("utf8");
process.stdin.on("data", (data) => {
  for (const line of data.trim().split("\n")) {
    const request = JSON.parse(line);
    if (request.operation === "cancel") {
      const target = pending.get(request.cancel.target_correlation_id);
      if (target) {
        pending.delete(request.cancel.target_correlation_id);
        process.stdout.write(JSON.stringify({version:"moltnet.machine.v1",correlation_id:target.correlation_id,operation:target.operation,error:{code:"canceled"}})+"\n");
      }
      process.stdout.write(JSON.stringify({version:"moltnet.machine.v1",correlation_id:request.correlation_id,operation:"cancel",cancel:{target_correlation_id:request.cancel.target_correlation_id,state:"canceled"}})+"\n");
    } else if (request.operation === "send_nudge") {
      process.stdout.write(JSON.stringify({version:"moltnet.machine.v1",correlation_id:request.correlation_id,operation:"send_nudge",send_nudge:{message_id:"message_1",event_id:"event_1",accepted:true,thread_created:false,dm_created:false}})+"\n");
    } else if (request.operation === "read") {
      pending.set(request.correlation_id, request);
    }
  }
});`;

const malformedScript = String.raw`
process.stdin.once("data", () => process.stdout.write('{"version":"moltnet.machine.v1","correlation_id":"send_bad","operation":"send_nudge","send_nudge":{"message_id":"message_1","event_id":"event_1","accepted":true,"thread_created":false,"dm_created":false},"unknown":true}\n'));
`;

const request = (correlation_id: string) => ({
  version: "moltnet.machine.v1" as const, correlation_id, operation: "send_nudge" as const,
  send_nudge: { delivery_id: `delivery_${correlation_id}`, target: { kind: "dm" as const, id: "peer_1" }, body: "wake" }
});

describe("MoltnetMachineClient", () => {
  it("uses one long-lived fake machine for send and cancellation", async () => {
    const client = createMoltnetMachineClient({ command: process.execPath, args: ["--input-type=module", "--eval", script] });
    const response = await client.request({
      version: "moltnet.machine.v1", correlation_id: "send_1", operation: "send_nudge",
      send_nudge: { delivery_id: "delivery_1", target: { kind: "dm", id: "peer_1" }, body: "wake" }
    });
    assert.equal(response.send_nudge?.message_id, "message_1");
    const controller = new AbortController();
    const pending = client.request({
      version: "moltnet.machine.v1", correlation_id: "read_1", operation: "read",
      read: { target: { kind: "dm", id: "peer_1" }, limit: 1 }
    }, controller.signal);
    controller.abort();
    await assert.rejects(pending, /aborted/u);
    const stillUsable = await client.request({
      version: "moltnet.machine.v1", correlation_id: "send_2", operation: "send_nudge",
      send_nudge: { delivery_id: "delivery_2", target: { kind: "dm", id: "peer_1" }, body: "wake" }
    });
    assert.equal(stillUsable.send_nudge?.message_id, "message_1");
    await client.close();
  });

  it("fails closed on a malformed machine frame", async () => {
    const client = createMoltnetMachineClient({ command: process.execPath, args: ["--input-type=module", "--eval", malformedScript] });
    await assert.rejects(client.request({
      version: "moltnet.machine.v1", correlation_id: "send_bad", operation: "send_nudge",
      send_nudge: { delivery_id: "delivery_bad", target: { kind: "dm", id: "peer_1" }, body: "wake" }
    }), /machine|response/u);
    await client.close();
  });

  it("drains bounded stdin writes and fails every pending request on a writer error", async () => {
    const stdout = new PassThrough();
    const received: string[] = [];
    const stdin = new Writable({ highWaterMark: 1, write(chunk, _encoding, done) {
      received.push(chunk.toString("utf8"));
      const frame = JSON.parse(chunk.toString("utf8")) as { correlation_id: string };
      setTimeout(() => {
        stdout.write(JSON.stringify({ version: "moltnet.machine.v1", correlation_id: frame.correlation_id, operation: "send_nudge", send_nudge: { message_id: "message_1", event_id: "event_1", accepted: true, thread_created: false, dm_created: false } }) + "\n");
        done();
      }, 1);
    }});
    const child = Object.assign(new EventEmitter(), { stdin, stdout, kill: () => true });
    const client = createMoltnetMachineClient({ command: "fake", spawnChild: () => child as never });
    const responses = await Promise.all(Array.from({ length: 16 }, (_, index) => client.request(request(`drain_${index}`))));
    assert.equal(responses.length, 16);
    assert.equal(received.length, 16);
    await client.close();

    const failedStdout = new PassThrough();
    const failedStdin = new Writable({ write(_chunk, _encoding, done) { done(new Error("writer failed")); } });
    const failedChild = Object.assign(new EventEmitter(), { stdin: failedStdin, stdout: failedStdout, kill: () => true });
    const failed = createMoltnetMachineClient({ command: "fake", spawnChild: () => failedChild as never });
    await assert.rejects(failed.request(request("writer_error")), /write|machine/u);
    await failed.close();
  });

  it("rejects an oversized unterminated stdout tail after a parsed line", async () => {
    const tailScript = String.raw`
process.stdin.once("data", (chunk) => {
  const request = JSON.parse(chunk.toString("utf8"));
  process.stdout.write(JSON.stringify({version:"moltnet.machine.v1",correlation_id:request.correlation_id,operation:"send_nudge",send_nudge:{message_id:"message_1",event_id:"event_1",accepted:true,thread_created:false,dm_created:false}})+"\n" + "x".repeat(16385));
});`;
    const client = createMoltnetMachineClient({ command: process.execPath, args: ["--input-type=module", "--eval", tailScript] });
    await client.request(request("tail_1"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    await assert.rejects(client.request(request("tail_2")), /closed|machine/u);
    await client.close();
  });

  it("forwards exactly one cancel for each active request before EOF settlement", async () => {
    const stdout = new PassThrough();
    const frames: Array<{ operation: string; cancel?: { target_correlation_id: string } }> = [];
    const stdin = new Writable({ write(chunk, _encoding, done) {
      frames.push(JSON.parse(chunk.toString("utf8")) as typeof frames[number]);
      done();
    }});
    const child = Object.assign(new EventEmitter(), { stdin, stdout, kill: () => true });
    const client = createMoltnetMachineClient({ command: "fake", spawnChild: () => child as never });
    const active = client.request({
      version: "moltnet.machine.v1", correlation_id: "read_eof", operation: "read",
      read: { target: { kind: "room", id: "room_1" }, limit: 1 }
    });
    stdout.end();
    await assert.rejects(active, /EOF/u);
    assert.deepEqual(frames.map((frame) => frame.operation), ["read", "cancel"]);
    assert.equal(frames[1]?.cancel?.target_correlation_id, "read_eof");
    await client.close();
  });

  it("drains EOF cancellation through a forced blocked writer without hanging", async () => {
    const stdout = new PassThrough();
    const frames: Array<{ operation: string; cancel?: { target_correlation_id: string } }> = [];
    let releaseInitial: (() => void) | undefined;
    const stdin = new Writable({ highWaterMark: 1, write(chunk, _encoding, done) {
      const frame = JSON.parse(chunk.toString("utf8")) as typeof frames[number];
      frames.push(frame);
      if (frame.operation === "read") releaseInitial = done;
      else setImmediate(done);
    }});
    const child = Object.assign(new EventEmitter(), { stdin, stdout, kill: () => true });
    const client = createMoltnetMachineClient({ command: "fake", spawnChild: () => child as never });
    const active = client.request({
      version: "moltnet.machine.v1", correlation_id: "read_blocked_eof", operation: "read",
      read: { target: { kind: "room", id: "room_1" }, limit: 1 }
    });
    stdout.end();
    assert.deepEqual(frames.map((frame) => frame.operation), ["read"]);
    releaseInitial?.();
    let timeout: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        assert.rejects(active, /EOF/u),
        new Promise<never>((_resolve, reject) => { timeout = setTimeout(() => reject(new Error("EOF drain hung")), 500); })
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
    assert.deepEqual(frames.map((frame) => frame.operation), ["read", "cancel"]);
    assert.equal(frames[1]?.cancel?.target_correlation_id, "read_blocked_eof");
    assert.equal(stdin.writableEnded, true);
    await assert.rejects(client.request(request("after_eof")), /closed/u);
    await client.close();
  });

  it("contains no direct provider transport implementation", async () => {
    const sources = await Promise.all(["client.ts", "protocol.ts", "types.ts"].map(async (name) =>
      readFile(new URL(`./${name}`, import.meta.url), "utf8")));
    for (const source of sources) {
      for (const forbidden of ["fetch(", "EventSource", "WebSocket", "Authorization", "Bearer ", "http://", "https://"]) {
        assert.equal(source.includes(forbidden), false, forbidden);
      }
    }
  });
});
