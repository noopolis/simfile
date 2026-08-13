import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import { once } from "node:events";
import { describe, it } from "node:test";

import { parseSimfileSource } from "../schema/parse.js";
import { runSimfileTrace } from "../runtime/trace.js";
import {
  WORLD_MESSAGE_EVENT_KINDS,
  isWorldMessageEvent,
  readWorldTranscriptFromMoltnet,
  sendWorldEventToMoltnet,
  sendWorldEventsToMoltnet
} from "./world-participant.js";

interface CapturedRequest {
  body: string;
  headers: Record<string, string>;
  path: string;
  method: string;
}

interface TestMoltnetTarget {
  kind?: string;
  room_id?: string;
  dm_id?: string;
  participant_ids?: unknown[];
}

interface TestMoltnetPart {
  kind?: string;
  text?: string;
  data?: Record<string, unknown>;
}

interface TestMoltnetRequest {
  id?: string;
  origin?: {
    network_id?: string;
    message_id?: string;
  };
  target?: TestMoltnetTarget;
  from?: {
    type?: string;
    id?: string;
    name?: string;
    network_id?: string;
  };
  parts?: TestMoltnetPart[];
}

const WORLD_MESSAGE_EVENT_KIND_SET = new Set<string>(WORLD_MESSAGE_EVENT_KINDS);

const parsePayload = async (request: IncomingMessage): Promise<string> => {
  const chunks: Buffer[] = [];
  request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
  await once(request, "end");
  return Buffer.concat(chunks).toString("utf8");
};

const startFakeMoltnetServer = async (): Promise<{
  baseUrl: string;
  close: () => Promise<void>;
  requests: CapturedRequest[];
}> => {
  const requests: CapturedRequest[] = [];
  const messages: Array<TestMoltnetRequest & { id: string }> = [];

  const server = createServer(async (request, response) => {
    const body = await parsePayload(request);
    const path = request.url ?? "";
    requests.push({
      body,
      headers: request.headers as Record<string, string>,
      path,
      method: request.method ?? "UNKNOWN"
    });

    if (request.method === "GET" && path.startsWith("/v1/rooms/")) {
      const roomId = decodeURIComponent(path.split("/")[3] ?? "");
      response.statusCode = 200;
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({
        messages: messages.filter((message) =>
          message.target?.kind === "room" && message.target.room_id === roomId
        )
      }));
      return;
    }

    if (request.method === "GET" && path.startsWith("/v1/dms/")) {
      const dmId = decodeURIComponent(path.split("/")[3] ?? "");
      response.statusCode = 200;
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({
        messages: messages.filter((message) =>
          message.target?.kind === "dm" && message.target.dm_id === dmId
        )
      }));
      return;
    }

    if (request.method !== "POST" || path !== "/v1/messages") {
      response.statusCode = 404;
      response.end();
      return;
    }

    const payload = JSON.parse(body) as TestMoltnetRequest;
    messages.push({ ...payload, id: payload.id ?? `msg_${requests.length}` });

    response.statusCode = 202;
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({
      message_id: `msg_${requests.length}`,
      event_id: `evt_${requests.length}`,
      accepted: true,
      thread_created: false,
      dm_created: false
    }));
  });

  await once(server.listen(0), "listening");
  const address = server.address();
  if (address === null || typeof address === "string") {
    await once(server.close(), "close");
    throw new Error("failed to bind fake moltnet server");
  }
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const close = () => new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });

  return { baseUrl, close, requests };
};

describe("Simfile Moltnet world participant", () => {
  it("posts only explicit world.message and world.dm events with event id metadata", async () => {
    const simfile = parseSimfileSource(`
simfile_version: "0.1"
name: world-participant-world
clock:
  seed: world-participant
  tick: 1m
rules:
  alert:
    when:
      event: clock.sync
    do:
      - action: moltnet:message
        to: room:office-floor:ops-room
        content: "Room alert"
      - action: moltnet:dm
        to: agent:alice
        content: "Private alert for alice"
`, { path: "Simfile.yaml" }).simfile;

    const trace = runSimfileTrace(simfile, { runId: "run-world", seed: "seed", ticks: 1 });
    const worldEvents = trace.events.filter(isWorldMessageEvent);
    assert.equal(worldEvents.length, 2);
    assert.deepEqual(worldEvents.map((event) => event.kind).sort(), [
      "world.dm",
      "world.message"
    ]);

    const { baseUrl, close, requests } = await startFakeMoltnetServer();
    try {
      const results = await sendWorldEventsToMoltnet(worldEvents, {
        authToken: "world-token",
        baseUrl,
        networkId: "office-floor"
      });
      assert.equal(results.length, 2);
      assert.equal(requests.length, 2);
      assert.equal(
        requests.every((entry) => entry.path === "/v1/messages"),
        true
      );
      assert.equal(requests.every((entry) => entry.method === "POST"), true);
      assert.equal(
        requests.every((entry) => entry.headers.authorization === "Bearer world-token"),
        true
      );

      const payloads = requests.map((entry) => JSON.parse(entry.body) as TestMoltnetRequest);
      const kinds = payloads.map((payload) => {
        if (typeof payload.target?.kind !== "string") {
          return "unknown";
        }
        return payload.target.kind;
      }).sort();
      assert.deepEqual(kinds, ["dm", "room"]);

      const eventIds = new Set(worldEvents.map((event) => event.event_id));
      for (const payload of payloads) {
        const eventKind = payload.parts?.[0]?.data?.simfile_event_kind;
        const eventId = payload.parts?.[0]?.data?.simfile_event_id;
        assert.equal(
          typeof eventKind === "string" && WORLD_MESSAGE_EVENT_KIND_SET.has(eventKind),
          true
        );
        assert.equal(
          typeof eventId,
          "string"
        );
        const requestId = (payload.id as string | undefined) ?? "";
        if (requestId.length > 0) {
          eventIds.delete(requestId);
        }
      }

      const roomTargets = payloads
        .map((payload) => (payload.target as { kind?: string; room_id?: string }).room_id)
        .filter((roomId): roomId is string => typeof roomId === "string");
      assert.deepEqual(roomTargets, ["ops-room"]);

      const dmTarget = payloads
        .map((payload) => payload.target as { kind?: string; dm_id?: string; participant_ids?: unknown })
        .find((target) => target.kind === "dm");
      assert.equal(dmTarget?.dm_id, "world-office-floor-alice");
      assert.deepEqual(dmTarget?.participant_ids, ["world", "alice"]);

      const transcript = await readWorldTranscriptFromMoltnet({
        authToken: "world-token",
        baseUrl,
        events: worldEvents,
        networkId: "office-floor"
      });
      assert.deepEqual(
        transcript.map((entry) => `${entry.kind}:${entry.eventId}`).sort(),
        worldEvents.map((event) => `${event.kind}:${event.event_id}`).sort()
      );

      const repeatedDmEvents = worldEvents
        .filter((event) => event.kind === "world.dm")
        .flatMap((event) => [
          event,
          { ...event, event_id: `${event.event_id}-later` }
        ]);
      await Promise.all(repeatedDmEvents.map((event) => sendWorldEventToMoltnet(event, {
        baseUrl,
        networkId: "office-floor",
        requestTimeoutMs: 0
      })));
      const dmPayloads = requests
        .map((entry) => entry.body ? JSON.parse(entry.body) as TestMoltnetRequest : undefined)
        .filter((payload): payload is TestMoltnetRequest => payload?.target?.kind === "dm");
      assert.deepEqual(new Set(dmPayloads.map((payload) => payload.target?.dm_id)), new Set(["world-office-floor-alice"]));
    } finally {
      await close();
    }
  });

  it("throws for unsupported event kinds", () => {
    const unsupportedEvent = {
      event_id: "run-id:1",
      kind: "rule.fired",
      sim_time: 0,
      provenance: "mechanical",
      actor: "rule",
      target: "rule",
      scope: "global",
      payload: {}
    } as const;

    return assert.rejects(() => sendWorldEventToMoltnet(unsupportedEvent, { baseUrl: "http://127.0.0.1:1" }));
  });

  it("cannot build or send a targeted recommendation event", async () => {
    let fetchCalls = 0;
    const recommendation = {
      event_id: "run-id:recommendation",
      kind: "wake.recommended",
      sim_time: 0,
      provenance: "mechanical",
      actor: "rule",
      target: "room:network:operations",
      scope: "room:network:operations",
      payload: { recipient: "agent:member" }
    } as const;

    await assert.rejects(() => sendWorldEventToMoltnet(recommendation, {
      baseUrl: "http://127.0.0.1:1",
      fetchFn: async () => {
        fetchCalls += 1;
        return new Response(null, { status: 202 });
      }
    }), /unsupported event kind/u);
    assert.equal(fetchCalls, 0);
    assert.equal(isWorldMessageEvent(recommendation), false);
  });
});
