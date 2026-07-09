import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, type IncomingMessage } from "node:http";
import { describe, it } from "node:test";

import {
  exportMoltnetTranscript,
  extractSimfileEventIds,
  requireMoltnetExportedTranscript,
  roomTranscriptTargetFromScope
} from "./transcript-export.js";

interface CapturedRequest {
  authorization?: string;
  path: string;
}

const readBody = async (request: IncomingMessage): Promise<void> => {
  request.resume();
  await once(request, "end");
};

const startTranscriptServer = async (): Promise<{
  baseUrl: string;
  close: () => Promise<void>;
  requests: CapturedRequest[];
}> => {
  const requests: CapturedRequest[] = [];
  const server = createServer(async (request, response) => {
    await readBody(request);
    const path = request.url ?? "";
    requests.push({
      authorization: request.headers.authorization,
      path
    });
    response.statusCode = 200;
    response.setHeader("Content-Type", "application/json");

    if (path.startsWith("/v1/rooms/case-warroom/messages")) {
      response.end(JSON.stringify({
        messages: [{
          id: "msg_room",
          parts: [{
            kind: "text",
            text: "Rosa Delgado belongs here.",
            data: { simfile_event_id: "run:10" }
          }],
          target: { kind: "room", room_id: "case-warroom" }
        }]
      }));
      return;
    }

    if (path.startsWith("/v1/dms/world-office-floor-eleanor/messages")) {
      response.end(JSON.stringify({
        messages: [{
          id: "msg_dm",
          parts: [{
            kind: "text",
            text: "Private perception.",
            data: { simfile_event_id: "run:11" }
          }],
          target: { kind: "dm", dm_id: "world-office-floor-eleanor" }
        }]
      }));
      return;
    }

    response.statusCode = 404;
    response.end(JSON.stringify({ error: "not found" }));
  });

  await once(server.listen(0), "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    await once(server.close(), "close");
    throw new Error("failed to bind transcript server");
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    }),
    requests
  };
};

describe("exportMoltnetTranscript", () => {
  it("labels real room and DM reads as moltnet-exported social truth", async () => {
    const { baseUrl, close, requests } = await startTranscriptServer();
    try {
      const transcript = await exportMoltnetTranscript({
        authToken: "observer-token",
        baseUrl,
        targets: [
          roomTranscriptTargetFromScope("room:office-floor:case-warroom"),
          { kind: "dm", id: "world-office-floor-eleanor" }
        ]
      });

      assert.equal(transcript.source, "moltnet-exported");
      assert.doesNotThrow(() => requireMoltnetExportedTranscript(transcript));
      assert.deepEqual(extractSimfileEventIds(transcript), ["run:10", "run:11"]);
      assert.deepEqual(
        transcript.conversations.map((conversation) => conversation.target.kind),
        ["room", "dm"]
      );
      assert.deepEqual(
        requests.map((request) => request.authorization),
        ["Bearer observer-token", "Bearer observer-token"]
      );
      assert.equal(requests[0]?.path, "/v1/rooms/case-warroom/messages?limit=200");
    } finally {
      await close();
    }
  });

  it("rejects harness-derived artifacts as full live acceptance evidence", () => {
    assert.throws(
      () => requireMoltnetExportedTranscript({ source: "harness-derived" }),
      /moltnet-exported transcript/u
    );
  });
});
