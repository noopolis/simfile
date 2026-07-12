import { readFile } from "node:fs/promises";
import path from "node:path";

import type { CausalStreamSource } from "../observe/causalStreams.js";
import { collectCausalStreams } from "../observe/causalStreams.js";
import { parseRunManifest } from "../observe/manifest.js";
import { readMnemeEventsByBank, readTranscript } from "./runRawArtifacts.js";
import type { RawMnemeEvent } from "./runViewModelTypes.js";
import type { ElementRef, RunTimeline, RunTimelineElement, TimelineEvent } from "./runTimelineTypes.js";
import { agentIdFromStreamId, agentRef, bankFromRelativePath, bankRef, roomRef, stringField } from "./runTimelineRefs.js";
import { buildBankLogRecord, buildCausalRecord, roomForMoltnetMessage, type JoinContext, type RawRecord } from "./runTimelineRecords.js";

/**
 * `buildRunTimeline` merges every causal record in a sealed run directory
 * into one deterministic, scrubbable `RunTimeline` (see `runTimelineTypes.ts`
 * for the shape and `VIEW_DESIGN.md` rule 7). This is the only file that
 * assigns the scrub key `t`; everything downstream (the world-trace adapter,
 * the web store, the chat/minds/portal views) treats `t` as ground truth.
 *
 * The per-authority record-building logic itself lives in
 * `runTimelineRecords.ts` (split out to keep this file, the orchestrator,
 * under 400 lines — `AGENTS.md`); this file owns merge order (`sortRecords`),
 * causal repair, dense `t` assignment, and element enumeration.
 */

const sortRecords = (records: readonly RawRecord[]): RawRecord[] =>
  [...records].sort((left, right) => {
    const timeDiff = Date.parse(left.recordedAt) - Date.parse(right.recordedAt);
    if (timeDiff !== 0) return timeDiff;
    if (left.authority !== right.authority) return left.authority.localeCompare(right.authority);
    if (left.streamId !== right.streamId) return left.streamId.localeCompare(right.streamId);
    if (left.seq !== right.seq) return left.seq - right.seq;
    return left.eventId.localeCompare(right.eventId);
  });

/**
 * Stable causal-repair pass: an event may not precede any of its own
 * `causeIds`. Repeatedly finds the first record whose latest-known cause
 * sits after it and re-splices it immediately after that cause, restarting
 * the scan after each move (small run sizes at this increment's scale make
 * the O(n^2) worst case negligible; correctness first).
 */
const causalRepair = (records: readonly RawRecord[]): RawRecord[] => {
  const order = [...records];
  const maxPasses = order.length + 5;

  for (let pass = 0; pass < maxPasses; pass += 1) {
    const indexOf = new Map(order.map((record, index) => [record.eventId, index] as const));
    let moved = false;

    for (let index = 0; index < order.length; index += 1) {
      const record = order[index]!;
      let latestCauseIndex = -1;
      for (const causeId of record.causeIds) {
        const causeIndex = indexOf.get(causeId);
        if (causeIndex !== undefined) latestCauseIndex = Math.max(latestCauseIndex, causeIndex);
      }
      if (latestCauseIndex > index) {
        order.splice(index, 1);
        order.splice(latestCauseIndex, 0, record);
        moved = true;
        break;
      }
    }

    if (!moved) break;
  }

  return order;
};

const buildElements = (params: {
  members: readonly string[];
  room?: ElementRef;
  roomId?: string;
  streams: readonly CausalStreamSource[];
  mnemeByBank: ReadonlyMap<string, readonly RawMnemeEvent[]>;
}): RunTimelineElement[] => {
  const elements = new Map<ElementRef, RunTimelineElement>();

  if (params.room && params.roomId) {
    elements.set(params.room, { ref: params.room, kind: "room", label: params.roomId });
  }

  for (const member of params.members) {
    const ref = agentRef(member);
    elements.set(ref, { ref, kind: "agent", label: member });
  }

  for (const stream of params.streams) {
    if (stream.authority !== "daimon") continue;
    for (const event of stream.events) {
      const agentId = agentIdFromStreamId(event.emitter.stream_id);
      if (!agentId) continue;
      const ref = agentRef(agentId);
      if (!elements.has(ref)) elements.set(ref, { ref, kind: "agent", label: agentId });
    }
  }

  for (const bankName of params.mnemeByBank.keys()) {
    const ref = bankRef(bankName);
    if (!elements.has(ref)) elements.set(ref, { ref, kind: "bank", label: bankName });
  }

  return [...elements.values()];
};

export const buildRunTimeline = async (runDir: string): Promise<RunTimeline> => {
  const manifest = parseRunManifest(JSON.parse(await readFile(path.join(runDir, "manifest.json"), "utf8")));
  const worldRecord = manifest.world as Record<string, unknown> | undefined;
  const networkId = stringField(worldRecord, "network_id");
  const roomId = stringField(worldRecord, "room_id");
  const room = networkId && roomId ? roomRef(networkId, roomId) : undefined;
  const membersRaw = worldRecord?.members;
  const members = Array.isArray(membersRaw) ? membersRaw.filter((member): member is string => typeof member === "string") : [];

  const [streams, mnemeByBank, transcript] = await Promise.all([
    collectCausalStreams(runDir),
    readMnemeEventsByBank(runDir),
    readTranscript(runDir),
  ]);

  const messagesById = new Map(transcript.transcript.map((message) => [message.id, message] as const));
  const roomsByMessageEventId = new Map<string, ElementRef>();
  for (const stream of streams) {
    if (stream.authority !== "moltnet") continue;
    for (const event of stream.events) {
      const messageRoom = roomForMoltnetMessage(event);
      if (messageRoom) roomsByMessageEventId.set(event.event_id, messageRoom);
    }
  }
  const memoryContentById = new Map<string, string>();
  for (const bankEvents of mnemeByBank.values()) {
    for (const event of bankEvents) memoryContentById.set(event.id, event.content.text);
  }
  const ctx: JoinContext = { room, messagesById, roomsByMessageEventId, memoryContentById };

  const records: RawRecord[] = [];
  for (const stream of streams) {
    const bank = bankFromRelativePath(stream.relativePath);
    for (const event of stream.events) {
      records.push(buildCausalRecord(event, stream.authority, bank, ctx));
    }
  }
  for (const [bankName, bankEvents] of mnemeByBank) {
    for (const event of bankEvents) records.push(buildBankLogRecord(event, bankName));
  }

  const repaired = causalRepair(sortRecords(records));

  const events: TimelineEvent[] = repaired.map((record, index) => ({
    t: index,
    eventId: record.eventId,
    authority: record.authority,
    streamId: record.streamId,
    seq: record.seq,
    type: record.type,
    viewClass: record.viewClass,
    recordedAt: record.recordedAt,
    actor: record.actor,
    subjects: record.subjects,
    causes: record.causeIds,
    text: record.text,
    worldEventId: record.worldEventId,
    payload: record.payload,
  }));

  const elements = buildElements({ members, room, roomId, streams, mnemeByBank });

  return { version: "simfile.run-timeline.v1", runId: manifest.run_id, events, elements, membranes: [] };
};
