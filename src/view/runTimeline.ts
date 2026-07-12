import { readFile } from "node:fs/promises";
import path from "node:path";

import type { CausalEvent } from "@noopolis/stele";

import type { CausalStreamSource } from "../observe/causalStreams.js";
import { collectCausalStreams } from "../observe/causalStreams.js";
import { parseRunManifest } from "../observe/manifest.js";
import { readMnemeEventsByBank, readTranscript } from "./runRawArtifacts.js";
import type { RawMnemeEvent, RawTranscriptMessage } from "./runViewModelTypes.js";
import type { ElementRef, RunTimeline, RunTimelineElement, TimelineEvent, TimelineViewClass } from "./runTimelineTypes.js";

/**
 * `buildRunTimeline` merges every causal record in a sealed run directory
 * into one deterministic, scrubbable `RunTimeline` (see `runTimelineTypes.ts`
 * for the shape and `VIEW_DESIGN.md` rule 7). This is the only file that
 * assigns the scrub key `t`; everything downstream (the world-trace adapter,
 * the web store, the chat/minds/portal views) treats `t` as ground truth.
 */

const agentRef = (id: string): ElementRef => `agent:${id}`;
const roomRef = (network: string, room: string): ElementRef => `room:${network}:${room}`;
const bankRef = (bank: string): ElementRef => `bank:${bank}`;

const isDefined = <T,>(value: T | undefined): value is T => value !== undefined;

const stringField = (record: Record<string, unknown> | undefined, key: string): string | undefined => {
  const value = record?.[key];
  return typeof value === "string" ? value : undefined;
};

const messageText = (message: RawTranscriptMessage): string =>
  message.parts.find((part) => part.kind === "text")?.text ?? "";

const agentIdFromStreamId = (streamId: string): string | undefined => streamId.match(/^agent:(.+)$/u)?.[1];

const networkIdFromStreamId = (streamId: string): string | undefined => streamId.match(/^network:(.+)$/u)?.[1];

const bankFromRelativePath = (relativePath: string): string | undefined => {
  const segments = relativePath.split(path.sep);
  return segments[0] === "raw" && segments[1] === "mneme" ? segments[2] : undefined;
};

/** Internal pre-`t` record: everything a `TimelineEvent` needs except its dense scrub index. */
interface RawRecord {
  eventId: string;
  authority: string;
  streamId: string;
  seq: number;
  type: string;
  viewClass: TimelineViewClass;
  recordedAt: string;
  causeIds: string[];
  actor?: string;
  subjects: ElementRef[];
  text?: string;
  payload: unknown;
}

const viewClassForCausalType = (type: string): TimelineViewClass => {
  switch (type) {
    case "message.accepted": return "message";
    case "control.wake.accepted": return "wake";
    case "turn.input.submitted": return "turn.input";
    case "turn.output.completed": return "turn.output";
    case "memory.recalled": return "memory.recalled";
    default: return "other";
  }
};

const viewClassForBankLogType = (type: string): TimelineViewClass => {
  switch (type) {
    case "memory.claimed": return "memory.claimed";
    case "memory.observed": return "memory.observed";
    case "memory.recalled": return "memory.recalled";
    default: return "other";
  }
};

interface JoinContext {
  room?: ElementRef;
  messagesById: ReadonlyMap<string, RawTranscriptMessage>;
  roomsByMessageEventId: ReadonlyMap<string, ElementRef>;
  memoryContentById: ReadonlyMap<string, string>;
}

const roomForMoltnetMessage = (event: CausalEvent): ElementRef | undefined => {
  if (event.type !== "message.accepted") return undefined;
  const networkId = networkIdFromStreamId(event.emitter.stream_id);
  const target = event.payload?.target;
  if (!networkId || typeof target !== "object" || target === null) return undefined;
  const targetRecord = target as Record<string, unknown>;
  const roomId = stringField(targetRecord, "room_id");
  return targetRecord.kind === "room" && roomId ? roomRef(networkId, roomId) : undefined;
};

const buildMoltnetRecord = (event: CausalEvent, base: Omit<RawRecord, "subjects" | "actor" | "text">, ctx: JoinContext): RawRecord => {
  if (event.type !== "message.accepted") {
    return { ...base, subjects: [ctx.room].filter(isDefined) };
  }
  const messageId = stringField(event.payload, "message_id");
  const message = messageId ? ctx.messagesById.get(messageId) : undefined;
  const authorId = message?.from.id;
  return {
    ...base,
    actor: authorId,
    subjects: [ctx.room, authorId ? agentRef(authorId) : undefined].filter(isDefined),
    text: message ? messageText(message) : undefined,
  };
};

const buildDaimonRecord = (event: CausalEvent, base: Omit<RawRecord, "subjects" | "actor" | "text">, ctx: JoinContext): RawRecord => {
  const agentId = agentIdFromStreamId(event.emitter.stream_id);
  const turnId = stringField(event.payload, "turn_id");
  const causingMessageEventIds = [
    turnId?.startsWith("moltnet:") ? turnId : undefined,
    ...event.cause_event_ids,
  ].filter(isDefined);
  const causingRoom = causingMessageEventIds
    .map((eventId) => ctx.roomsByMessageEventId.get(eventId))
    .find(isDefined);
  const subjects = [agentId ? agentRef(agentId) : undefined, causingRoom].filter(isDefined);

  let text: string | undefined;
  if (event.type === "turn.input.submitted") {
    const causingMessageId = turnId?.startsWith("moltnet:") ? turnId.slice("moltnet:".length) : undefined;
    const causingMessage = causingMessageId ? ctx.messagesById.get(causingMessageId) : undefined;
    text = causingMessage ? messageText(causingMessage) : undefined;
  }

  return { ...base, actor: agentId, subjects, text };
};

const buildMnemeCausalRecord = (event: CausalEvent, bank: string | undefined, base: Omit<RawRecord, "subjects" | "actor" | "text">, ctx: JoinContext): RawRecord => {
  const agentId = event.principal_id.startsWith("agent:") ? event.principal_id.slice("agent:".length) : undefined;
  const subjects = [bank ? bankRef(bank) : undefined, agentId ? agentRef(agentId) : undefined].filter(isDefined);

  let text: string | undefined;
  if (event.type === "memory.recalled") {
    const memoryId = stringField(event.payload, "memory_id");
    text = memoryId ? ctx.memoryContentById.get(memoryId) : undefined;
  }

  return { ...base, actor: agentId, subjects, text };
};

const buildCausalRecord = (
  event: CausalEvent,
  authority: string,
  bank: string | undefined,
  ctx: JoinContext,
): RawRecord => {
  const base: Omit<RawRecord, "subjects" | "actor" | "text"> = {
    eventId: event.event_id,
    authority,
    streamId: event.emitter.stream_id,
    seq: event.emitter.seq,
    type: event.type,
    viewClass: viewClassForCausalType(event.type),
    recordedAt: event.recorded_at,
    causeIds: event.cause_event_ids,
    payload: event.payload,
  };

  if (authority === "moltnet") return buildMoltnetRecord(event, base, ctx);
  if (authority === "daimon") return buildDaimonRecord(event, base, ctx);
  if (authority === "mneme") return buildMnemeCausalRecord(event, bank, base, ctx);
  return { ...base, subjects: [] };
};

const buildBankLogRecord = (event: RawMnemeEvent, bankName: string): RawRecord => {
  const agentId = event.principal.agentId;
  return {
    eventId: event.id,
    authority: "mneme",
    streamId: bankRef(bankName),
    seq: event.seq ?? 0,
    type: event.type,
    viewClass: viewClassForBankLogType(event.type),
    recordedAt: event.createdAt,
    causeIds: event.parentEventIds ?? [],
    actor: agentId,
    subjects: [bankRef(bankName), agentRef(agentId)],
    text: event.content.text,
    payload: event.content,
  };
};

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
    payload: record.payload,
  }));

  const elements = buildElements({ members, room, roomId, streams, mnemeByBank });

  return { version: "simfile.run-timeline.v1", runId: manifest.run_id, events, elements, membranes: [] };
};
