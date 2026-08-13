import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { it } from "node:test";

import { collectCausalStreams } from "./causalStreams.js";
import { findRunRawFiles } from "./rawFiles.js";
import { buildRunTimeline } from "../view/runTimeline.js";

const digest = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

const causal = (input: Readonly<{
  causeIds?: string[];
  eventId: string;
  messageId?: string;
  principal: string;
  seq: number;
  streamId: string;
  system: "daimon" | "moltnet";
  type: string;
}>): string => `${JSON.stringify({
  cause_event_ids: input.causeIds ?? [],
  emitter: { seq: input.seq, stream_id: input.streamId, system: input.system },
  event_id: input.eventId,
  payload: input.messageId === undefined ? { turn_id: "turn-1" } : {
    content_sha256: "a".repeat(64),
    message_id: input.messageId,
    policy_decision: "accepted",
    target: { kind: "room", room_id: "room-1" },
  },
  principal_id: input.principal,
  recorded_at: `2026-08-10T00:00:0${input.seq}.000Z`,
  run_id: "nested-raw-run",
  type: input.type,
  version: "noopolis.causal-event.v1",
})}\n`;

it("reads manifest-declared nested raw evidence without admitting planted sibling files", async () => {
  const runDir = await mkdtemp(path.join(tmpdir(), "simfile-nested-raw-"));
  const topPath = "raw/moltnet/causal.jsonl";
  const nestedPath = "organization/raw/daimon/agent-a/causal.jsonl";
  const transcriptPath = "organization/raw/moltnet/transcript.json";
  const plantedPath = "shadow/raw/mneme/planted/causal.jsonl";
  const messageId = "message-1";
  const messageEventId = "moltnet:message-1";
  const top = causal({ eventId: messageEventId, messageId, principal: "agent:agent-a",
    seq: 1, streamId: "network:net-1", system: "moltnet", type: "message.accepted" });
  const nested = causal({ causeIds: [messageEventId], eventId: "daimon:turn-1",
    principal: "agent:agent-a", seq: 2, streamId: "agent:agent-a",
    system: "daimon", type: "turn.input.submitted" });
  const transcript = `${JSON.stringify({
    conversations: [{ messages: [{ created_at: "2026-08-10T00:00:01.000Z",
      from: { id: "agent-a" }, id: messageId,
      parts: [{ kind: "text", text: "nested hello" }] }] }],
    version: "moltnet.transcript-export.v1",
  })}\n`;
  try {
    for (const relative of [topPath, nestedPath, transcriptPath, plantedPath]) {
      await mkdir(path.dirname(path.join(runDir, relative)), { recursive: true });
    }
    await Promise.all([
      writeFile(path.join(runDir, topPath), top),
      writeFile(path.join(runDir, nestedPath), nested),
      writeFile(path.join(runDir, transcriptPath), transcript),
      writeFile(path.join(runDir, plantedPath), nested),
    ]);
    await writeFile(path.join(runDir, "manifest.json"), JSON.stringify({
      artifacts: [nestedPath, transcriptPath].map((artifactPath) => ({
        path: artifactPath,
        sha256: digest(artifactPath === nestedPath ? nested : transcript),
      })),
      contract_versions: {},
      created_at: "2026-08-10T00:00:00.000Z",
      run_id: "nested-raw-run",
      version: "simfile.run-manifest.v1",
    }));

    const files = await findRunRawFiles(runDir);
    assert.deepEqual(files.map(({ relativePath }) => relativePath),
      [nestedPath, transcriptPath, topPath]);
    assert.ok(files.every(({ relativePath }) => relativePath !== plantedPath));

    const streams = await collectCausalStreams(runDir);
    assert.deepEqual(streams.map(({ authority, relativePath }) =>
      ({ authority, relativePath })), [
      { authority: "daimon", relativePath: nestedPath },
      { authority: "moltnet", relativePath: topPath },
    ]);
    const timeline = await buildRunTimeline(runDir);
    assert.equal(timeline.events.length, 2);
    assert.equal(timeline.events.find(({ eventId }) => eventId === messageEventId)?.text,
      "nested hello");
    assert.ok(timeline.elements.some(({ ref }) => ref === "agent:agent-a"));
  } finally {
    await rm(runDir, { force: true, recursive: true });
  }
});

it("preserves no-manifest top-level reads and fails closed on nested ambiguity or escape", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "simfile-raw-boundary-"));
  const runDir = path.join(root, "run");
  const outside = path.join(root, "outside.jsonl");
  const topPath = "raw/moltnet/causal.jsonl";
  const nestedPath = "organization/raw/moltnet/causal.jsonl";
  try {
    await mkdir(path.dirname(path.join(runDir, topPath)), { recursive: true });
    await writeFile(path.join(runDir, topPath), "top\n");
    assert.deepEqual((await findRunRawFiles(runDir)).map(({ relativePath }) =>
      relativePath), [topPath]);

    await mkdir(path.dirname(path.join(runDir, nestedPath)), { recursive: true });
    await writeFile(path.join(runDir, nestedPath), "nested\n");
    await writeFile(path.join(runDir, "manifest.json"), JSON.stringify({
      artifacts: [{ path: nestedPath, sha256: digest("nested\n") }],
      contract_versions: {}, created_at: "2026-08-10T00:00:00.000Z",
      run_id: "raw-boundary", version: "simfile.run-manifest.v1",
    }));
    await assert.rejects(findRunRawFiles(runDir), /ambiguous raw artifact/u);

    await rm(path.join(runDir, "raw"), { force: true, recursive: true });
    await rm(path.join(runDir, nestedPath), { force: true });
    await writeFile(outside, "outside\n");
    await symlink(outside, path.join(runDir, nestedPath));
    await assert.rejects(findRunRawFiles(runDir), /escapes the run directory/u);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

it("leaves a missing manifest-declared nested artifact to the integrity report", async () => {
  const runDir = await mkdtemp(path.join(tmpdir(), "simfile-raw-missing-"));
  try {
    await writeFile(path.join(runDir, "manifest.json"), JSON.stringify({
      artifacts: [{
        path: "organization/raw/moltnet/missing.jsonl",
        sha256: digest("missing\n"),
      }],
      contract_versions: {}, created_at: "2026-08-10T00:00:00.000Z",
      run_id: "raw-missing", version: "simfile.run-manifest.v1",
    }));

    assert.deepEqual(await findRunRawFiles(runDir), []);
  } finally {
    await rm(runDir, { force: true, recursive: true });
  }
});
