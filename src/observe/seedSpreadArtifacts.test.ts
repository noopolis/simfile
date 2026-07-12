import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import {
  readSpreadMnemeEventsByBank,
  readSpreadTranscriptMessages,
  readTickByIngestedMessageId
} from "./seedSpreadArtifacts.js";

const makeRunDir = async (): Promise<string> => mkdtemp(path.join(tmpdir(), "simfile-seed-spread-artifacts-"));

describe("readSpreadTranscriptMessages", () => {
  it("flattens every conversation's messages from the moltnet.transcript-export.v1 shape", async () => {
    const runDir = await makeRunDir();
    await mkdir(path.join(runDir, "raw", "moltnet"), { recursive: true });
    await writeFile(
      path.join(runDir, "raw", "moltnet", "transcript.json"),
      JSON.stringify({
        version: "simfile.moltnet.transcript.v1",
        source: "moltnet-exported",
        conversations: [
          {
            target: { kind: "room", id: "office-room" },
            messages: [
              { id: "msg1", from: { id: "eleanor" }, parts: [{ kind: "text", text: "Rosa Delgado, propose." }] },
              { id: "msg2", from: { id: "sam" }, parts: [{ kind: "text", text: "Works for me." }] }
            ]
          }
        ]
      }),
      "utf8"
    );

    const messages = await readSpreadTranscriptMessages(runDir);
    assert.deepEqual(messages, [
      { id: "msg1", fromId: "eleanor", text: "Rosa Delgado, propose." },
      { id: "msg2", fromId: "sam", text: "Works for me." }
    ]);
  });

  it("returns an empty list when no transcript.json exists under raw/moltnet", async () => {
    const runDir = await makeRunDir();
    const messages = await readSpreadTranscriptMessages(runDir);
    assert.deepEqual(messages, []);
  });
});

describe("readSpreadMnemeEventsByBank", () => {
  it("parses every bank's events.jsonl into {id, type, agentId, text}, keyed by bank", async () => {
    const runDir = await makeRunDir();
    const bankDir = path.join(runDir, "raw", "mneme", "office-recall");
    await mkdir(bankDir, { recursive: true });
    const lines = [
      { id: "evt1", type: "memory.observed", principal: { agentId: "eleanor" }, content: { text: "Rosa Delgado account." } },
      { id: "evt2", type: "memory.recalled", principal: { agentId: "eleanor" }, content: { text: "Recalled." } }
    ]
      .map((line) => JSON.stringify(line))
      .join("\n");
    await writeFile(path.join(bankDir, "events.jsonl"), lines, "utf8");

    const byBank = await readSpreadMnemeEventsByBank(runDir);
    assert.deepEqual(byBank.get("office-recall"), [
      { id: "evt1", type: "memory.observed", agentId: "eleanor", text: "Rosa Delgado account." },
      { id: "evt2", type: "memory.recalled", agentId: "eleanor", text: "Recalled." }
    ]);
  });

  it("skips a malformed line rather than crashing the whole read", async () => {
    const runDir = await makeRunDir();
    const bankDir = path.join(runDir, "raw", "mneme", "office-recall");
    await mkdir(bankDir, { recursive: true });
    await writeFile(
      path.join(bankDir, "events.jsonl"),
      `not-json\n${JSON.stringify({ id: "evt1", type: "memory.observed", principal: { agentId: "eleanor" }, content: { text: "ok" } })}`,
      "utf8"
    );

    const byBank = await readSpreadMnemeEventsByBank(runDir);
    assert.deepEqual(byBank.get("office-recall"), [
      { id: "evt1", type: "memory.observed", agentId: "eleanor", text: "ok" }
    ]);
  });
});

describe("readTickByIngestedMessageId", () => {
  it("joins message_id -> tick from world/ingested-messages.jsonl, first tick wins", async () => {
    const runDir = await makeRunDir();
    await mkdir(path.join(runDir, "world"), { recursive: true });
    const lines = [
      { tick: 0, message_ids: ["msg1"] },
      { tick: 3, message_ids: ["msg2", "msg3"] }
    ]
      .map((line) => JSON.stringify(line))
      .join("\n");
    await writeFile(path.join(runDir, "world", "ingested-messages.jsonl"), lines, "utf8");

    const byMessageId = await readTickByIngestedMessageId(runDir);
    assert.equal(byMessageId.get("msg1"), 0);
    assert.equal(byMessageId.get("msg2"), 3);
    assert.equal(byMessageId.get("msg3"), 3);
  });

  it("returns an empty map when the run wasn't world-driven (no world/ingested-messages.jsonl)", async () => {
    const runDir = await makeRunDir();
    const byMessageId = await readTickByIngestedMessageId(runDir);
    assert.deepEqual([...byMessageId.entries()], []);
  });
});
