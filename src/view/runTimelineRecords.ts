import type { CausalEvent } from "@noopolis/stele";

import type { RawMnemeEvent, RawTranscriptMessage } from "./runViewModelTypes.js";
import type { ElementRef, TimelineViewClass } from "./runTimelineTypes.js";
import { agentIdFromStreamId, agentRef, bankRef, isDefined, messageText, networkIdFromStreamId, roomRef, stringField, variableRef } from "./runTimelineRefs.js";

/**
 * Per-authority (`moltnet`/`daimon`/`mneme`/`world`/mneme-bank-log) raw
 * record builders, split out of `runTimeline.ts` (`AGENTS.md`: split before
 * 400 lines) so the orchestrator (`buildRunTimeline`: merge, sort, causal
 * repair, dense `t` assignment) stays the file that's easy to read
 * end-to-end. `buildCausalRecord` is the one dispatcher every
 * `raw/<authority>/causal.jsonl` record goes through; `buildBankLogRecord`
 * is the parallel path for a mneme bank's `events.jsonl` rows.
 */

/** Internal pre-`t` record: everything a `TimelineEvent` needs except its dense scrub index. */
export interface RawRecord {
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
  /** See `TimelineEvent.worldEventId`'s doc comment (`runTimelineTypes.ts`). */
  worldEventId?: string;
  payload: unknown;
}

export interface JoinContext {
  room?: ElementRef;
  messagesById: ReadonlyMap<string, RawTranscriptMessage>;
  roomsByMessageEventId: ReadonlyMap<string, ElementRef>;
  memoryContentById: ReadonlyMap<string, string>;
}

const viewClassForCausalType = (type: string): TimelineViewClass => {
  switch (type) {
    case "message.accepted": return "message";
    case "control.wake.accepted": return "wake";
    case "turn.input.submitted": return "turn.input";
    case "turn.output.completed": return "turn.output";
    case "memory.recalled": return "memory.recalled";
    // World-authority additions (increment 3, `buildWorldRecord` below):
    // `world.message` is a message like any other room chat line.
    case "clock.sync": return "clock";
    case "marker.seen": return "marker";
    case "world.message": return "message";
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

/** Resolves the room a moltnet `message.accepted` event targeted — `buildRunTimeline` uses this directly (not just `buildMoltnetRecord`) to build `roomsByMessageEventId`, the daimon-attribution join surface. */
export const roomForMoltnetMessage = (event: CausalEvent): ElementRef | undefined => {
  if (event.type !== "message.accepted") return undefined;
  const networkId = networkIdFromStreamId(event.emitter.stream_id);
  const target = event.payload?.target;
  if (!networkId || typeof target !== "object" || target === null) return undefined;
  const targetRecord = target as Record<string, unknown>;
  const roomId = stringField(targetRecord, "room_id");
  return targetRecord.kind === "room" && roomId ? roomRef(networkId, roomId) : undefined;
};

/**
 * The `simfile_event_id` breadcrumb `src/moltnet/world-participant.ts`'s
 * `metadataFromEvent` attaches to a message's first text part's `data` when
 * that message originated from a world action — the real join surface for
 * "this moltnet message echoes that world-authority event" (increment 3
 * dedup rule). Undefined for a genuine agent-authored message, which has no
 * such breadcrumb.
 */
const worldEventIdFromMessage = (message: RawTranscriptMessage): string | undefined => {
  const breadcrumb = message.parts.find((part) => part.kind === "text")?.data?.simfile_event_id;
  return typeof breadcrumb === "string" ? breadcrumb : undefined;
};

const buildMoltnetRecord = (event: CausalEvent, base: Omit<RawRecord, "subjects" | "actor" | "text">, ctx: JoinContext): RawRecord => {
  // A message.accepted names its OWN room from its network stream_id +
  // target.room_id (`roomForMoltnetMessage`), never the run's single primary
  // room — the fix that keeps an inner-council message under
  // `room:<inner_net>:<room>` in a multi-network run instead of collapsing
  // every network's messages onto the floor room. Falls back to `ctx.room`
  // only when the event carries no resolvable target (never, for a
  // message.accepted).
  const messageRoom = roomForMoltnetMessage(event) ?? ctx.room;
  if (event.type !== "message.accepted") {
    return { ...base, subjects: [ctx.room].filter(isDefined) };
  }
  const messageId = stringField(event.payload, "message_id");
  const message = messageId ? ctx.messagesById.get(messageId) : undefined;
  const authorId = message?.from.id;
  return {
    ...base,
    actor: authorId,
    subjects: [messageRoom, authorId ? agentRef(authorId) : undefined].filter(isDefined),
    text: message ? messageText(message) : undefined,
    worldEventId: message ? worldEventIdFromMessage(message) : undefined,
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

const roomTargetPattern = /^room:[^:]+:[^:]+$/u;
const agentTargetPattern = /^agent:[^:]+$/u;

/**
 * The world clock's own anchor — increment 3's `clock.sync` subject. A
 * `clock.sync` event names the tick axis itself, not any one room or agent,
 * so it gets a dedicated ref rather than an empty `subjects` array (which
 * would make it invisible to any future "world clock" storyline portal).
 */
const globalClockRef: ElementRef = "clock:global";

/**
 * The world stream's own `payload.target` is already an `ElementRef`-shaped
 * string (`room:<network>:<room>` or `agent:<id>`, per
 * `src/runtime/rule-actions.ts`'s `action.to` — a Simfile rule's `to:`
 * field, e.g. `room:office_lab:office-room` or `agent:eleanor`) for every
 * world event kind this run emits. Returned verbatim when it matches one of
 * those two shapes; `undefined` otherwise (e.g. `clock.sync`'s `"global"`,
 * which has no per-room/per-agent subject of its own).
 */
const worldTargetRef = (payload: Record<string, unknown> | undefined): ElementRef | undefined => {
  const target = stringField(payload, "target");
  if (!target) return undefined;
  return roomTargetPattern.test(target) || agentTargetPattern.test(target) ? target : undefined;
};

/**
 * Increment 4's variable storyline join: the `variables: string[]` payload
 * field `src/runtime/step-tick.ts`'s `runRule` (and `rule-actions.ts`'s
 * `emitRuleActionEvents`) stamps onto a `rule.fired` event and every
 * world-effect event it emits, whenever that rule's own `when:` condition
 * references at least one variable (`conditionVariableIds`). Read straight
 * off the event's own payload — never invented — and turned into
 * `variable:<id>` subjects so the variable's storyline
 * (`eventsForElement(timeline, "variable:<id>")`) includes the rule firing
 * and the message/dm it caused. Absent on a `clock.sync` (every tick,
 * not this rule's own event) and on any rule with no variable condition.
 */
const variableRefsFromPayload = (payload: Record<string, unknown> | undefined): ElementRef[] => {
  const raw = payload?.variables;
  if (!Array.isArray(raw)) return [];
  return raw.filter((id): id is string => typeof id === "string").map(variableRef);
};

/**
 * World-authority records (`raw/world/causal.jsonl`, increment 3): the
 * mechanical clock/marker/message/wake stream a world-driven run emits
 * alongside the agents' own moltnet/daimon/mneme streams.
 * - `clock.sync` anchors the tick axis itself (`globalClockRef`), never a
 *   room — it is the run's own heartbeat, not a room event.
 * - `marker.seen` is attributed to the room plus the real agent who
 *   authored the moltnet message that tripped it, joined by
 *   `source_event_id` (a bare transcript message `id`, never `moltnet:`-
 *   prefixed — confirmed against this run's own fixture) against
 *   `ctx.messagesById`, never invented from the marker's own `alias`.
 * - `world.message`/`world.dm` are attributed to the room/agent the action
 *   targeted, with `text` joined from the event's own `content` field (the
 *   same text moltnet re-delivers as the echo message this dedups against).
 * - `world.act` is attributed directly to the fed variable it wrote
 *   (`payload.target` IS the variable id for this event type, unlike every
 *   other world event kind where `target` is a room/agent ref).
 * - Any other world event type (`rule.fired`, ...) falls back to the event's
 *   own `target` ref, or the run's single room
 *   when `target` doesn't resolve to one.
 * - Every branch additionally folds in `variable:<id>` subjects from the
 *   event's own `payload.variables` (`variableRefsFromPayload`) when
 *   present — increment 4's variable storyline join.
 */
const buildWorldRecord = (event: CausalEvent, base: Omit<RawRecord, "subjects" | "actor" | "text">, ctx: JoinContext): RawRecord => {
  const payload = event.payload as Record<string, unknown> | undefined;
  const targetRef = worldTargetRef(payload);
  const variableSubjects = variableRefsFromPayload(payload);
  const withVariableSubjects = (record: RawRecord): RawRecord =>
    variableSubjects.length === 0 ? record : { ...record, subjects: [...new Set([...record.subjects, ...variableSubjects])] };

  if (event.type === "clock.sync") {
    return withVariableSubjects({ ...base, subjects: [globalClockRef] });
  }

  if (event.type === "marker.seen") {
    const sourceEventId = stringField(payload, "source_event_id");
    const sourceMessage = sourceEventId ? ctx.messagesById.get(sourceEventId) : undefined;
    const authorId = sourceMessage?.from.id;
    return withVariableSubjects({
      ...base,
      actor: authorId,
      subjects: [ctx.room ?? targetRef, authorId ? agentRef(authorId) : undefined].filter(isDefined),
    });
  }

  if (event.type === "world.message" || event.type === "world.dm") {
    return withVariableSubjects({
      ...base,
      subjects: [ctx.room ?? targetRef].filter(isDefined),
      text: stringField(payload, "content"),
    });
  }

  if (event.type === "world.act") {
    const fedVariableId = stringField(payload, "target");
    return withVariableSubjects({
      ...base,
      subjects: [fedVariableId ? variableRef(fedVariableId) : (targetRef ?? ctx.room)].filter(isDefined),
    });
  }

  return withVariableSubjects({ ...base, subjects: [targetRef ?? ctx.room].filter(isDefined) });
};

/** The one dispatcher every `raw/<authority>/causal.jsonl` record goes through. */
export const buildCausalRecord = (
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
  if (authority === "world") return buildWorldRecord(event, base, ctx);
  return { ...base, subjects: [] };
};

/** The parallel path for a mneme bank's `events.jsonl` rows (the human-readable memory log, distinct from that bank's `causal.jsonl`). */
export const buildBankLogRecord = (event: RawMnemeEvent, bankName: string): RawRecord => {
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
