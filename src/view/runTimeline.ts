import { readFile } from "node:fs/promises";
import path from "node:path";

import type { CausalStreamSource } from "../observe/causalStreams.js";
import { collectCausalStreams } from "../observe/causalStreams.js";
import { parseRunManifest } from "../observe/manifest.js";
import { readMnemeEventsByBank, readTranscript } from "./runRawArtifacts.js";
import type { RawMnemeEvent } from "./runViewModelTypes.js";
import type { ElementRef, RunTimeline, RunTimelineElement, RunTimelineMembrane, TimelineEvent } from "./runTimelineTypes.js";
import { agentIdFromStreamId, agentRef, bankFromRelativePath, bankRef, roomRef, stringField } from "./runTimelineRefs.js";
import { readRunMembranes } from "./membranes.js";
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

/** One room the run declares (`manifest.world`): a `room:<network>:<room>` ref, its bare room id (label), and its member agent ids. */
interface WorldRoom {
  ref: ElementRef;
  roomId: string;
  members: string[];
}

const buildElements = (params: {
  rooms: readonly WorldRoom[];
  membranes: readonly RunTimelineMembrane[];
  streams: readonly CausalStreamSource[];
  mnemeByBank: ReadonlyMap<string, readonly RawMnemeEvent[]>;
}): RunTimelineElement[] => {
  const elements = new Map<ElementRef, RunTimelineElement>();

  for (const room of params.rooms) {
    elements.set(room.ref, { ref: room.ref, kind: "room", label: room.roomId });
    for (const member of room.members) {
      const ref = agentRef(member);
      if (!elements.has(ref)) elements.set(ref, { ref, kind: "agent", label: member });
    }
  }

  for (const membrane of params.membranes) {
    if (!elements.has(membrane.ref)) elements.set(membrane.ref, { ref: membrane.ref, kind: "team", label: membrane.label });
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

const stringMembers = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((member): member is string => typeof member === "string") : [];

/**
 * Parses `manifest.world` into the run's rooms, supporting both shapes: a
 * single-network run's flat `{network_id, room_id, members}` (office-sim
 * golden) and a multi-network composed run's `{rooms: [{network_id, room_id,
 * members}, ...]}` (the jungian psyche, one entry per network's room).
 */
const parseWorldRooms = (worldRecord: Record<string, unknown> | undefined): WorldRoom[] => {
  const toRoom = (record: Record<string, unknown> | undefined): WorldRoom | undefined => {
    const networkId = stringField(record, "network_id");
    const roomId = stringField(record, "room_id");
    if (!networkId || !roomId) return undefined;
    return { ref: roomRef(networkId, roomId), roomId, members: stringMembers(record?.members) };
  };

  const roomsRaw = worldRecord?.rooms;
  if (Array.isArray(roomsRaw)) {
    return roomsRaw
      .map((entry) => toRoom(typeof entry === "object" && entry !== null ? (entry as Record<string, unknown>) : undefined))
      .filter((room): room is WorldRoom => room !== undefined);
  }

  const single = toRoom(worldRecord);
  return single ? [single] : [];
};

export const buildRunTimeline = async (runDir: string): Promise<RunTimeline> => {
  const manifest = parseRunManifest(JSON.parse(await readFile(path.join(runDir, "manifest.json"), "utf8")));
  const worldRecord = manifest.world as Record<string, unknown> | undefined;
  const rooms = parseWorldRooms(worldRecord);
  const room = rooms[0]?.ref;

  const [streams, mnemeByBank, transcript, membranes] = await Promise.all([
    collectCausalStreams(runDir),
    readMnemeEventsByBank(runDir),
    readTranscript(runDir),
    readRunMembranes(runDir),
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

  const elements = buildElements({ rooms, membranes, streams, mnemeByBank });

  return { version: "simfile.run-timeline.v1", runId: manifest.run_id, events, elements, membranes };
};
