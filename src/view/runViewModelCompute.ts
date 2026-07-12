import type { ArtifactIntegrityCheck } from "../observe/artifacts.js";
import type { SimfileRunManifest } from "../observe/manifest.js";
import type { SimfileObserveReport } from "../observe/report.js";
import type {
  RawMnemeEvent,
  RawTranscript,
  RawTranscriptMessage,
  RunMindPortal,
  RunMindRow,
  RunMindStratum,
  RunProvenanceEntry,
  RunThreadMessage,
  RunThreadTrace,
  RunVerdict,
  RunViewModel
} from "./runViewModelTypes.js";

import type { CausalEvent } from "@noopolis/stele";

const MIND_STRATA: Record<string, RunMindStratum> = {
  "memory.claimed": "claimed",
  "memory.observed": "observed",
  "memory.recalled": "recalled"
};

const agentIdFromFqid = (fqid: string): string | undefined => fqid.split("/").pop();

const extractMentions = (message: RawTranscriptMessage): string[] =>
  (message.mentions ?? [])
    .map(agentIdFromFqid)
    .filter((id): id is string => typeof id === "string" && id.length > 0);

const messageText = (message: RawTranscriptMessage): string =>
  message.parts.find((part) => part.kind === "text")?.text ?? "";

/**
 * Merges every mneme bank's `events.jsonl` rows (in file-encounter order,
 * banks iterated in map insertion order) and groups them by
 * `principal.agentId`. Shared by `computeMinds` (aggregate portal view) and
 * `computeThread` (per-turn memory-write grouping) so both read the exact
 * same ordered record set.
 */
export const mindRowsByAgent = (
  mnemeEventsByBank: ReadonlyMap<string, readonly RawMnemeEvent[]>
): Map<string, RunMindRow[]> => {
  const byAgent = new Map<string, RunMindRow[]>();
  for (const events of mnemeEventsByBank.values()) {
    for (const event of events) {
      const stratum = MIND_STRATA[event.type];
      if (!stratum) continue;
      const rows = byAgent.get(event.principal.agentId) ?? [];
      rows.push({ stratum, text: event.content.text, sourceId: event.id });
      byAgent.set(event.principal.agentId, rows);
    }
  }
  return byAgent;
};

export const computeMinds = (
  mnemeEventsByBank: ReadonlyMap<string, readonly RawMnemeEvent[]>
): RunMindPortal[] =>
  [...mindRowsByAgent(mnemeEventsByBank)]
    .map(([agentId, rows]) => ({ agentId, eventCount: rows.length, rows }))
    .sort((left, right) => left.agentId.localeCompare(right.agentId));

/**
 * Splits one agent's ordered mind rows into per-turn groups: each
 * `"claimed"` row (mneme's "took the wake request in" record — always the
 * first write of a turn) opens a new group; every row until the next
 * `"claimed"` belongs to that same turn. Purely structural — no content
 * matching — so it generalizes to any run, not just the golden fixture.
 */
const groupMindRowsByTurn = (rows: readonly RunMindRow[]): RunMindRow[][] => {
  const groups: RunMindRow[][] = [];
  for (const row of rows) {
    if (row.stratum === "claimed" || groups.length === 0) {
      groups.push([row]);
    } else {
      groups[groups.length - 1]!.push(row);
    }
  }
  return groups;
};

const daimonEventsForAgent = (
  events: readonly CausalEvent[],
  agentId: string
): readonly CausalEvent[] =>
  events.filter(
    (event) => event.emitter.system === "daimon" && event.emitter.stream_id === `agent:${agentId}`
  );

const findTurnInput = (
  agentEvents: readonly CausalEvent[],
  triggerEventId: string
): CausalEvent | undefined =>
  agentEvents.find(
    (event) =>
      event.type === "turn.input.submitted" &&
      Array.isArray(event.payload.input_message_ids) &&
      event.payload.input_message_ids.includes(triggerEventId)
  );

const findTurnOutput = (
  agentEvents: readonly CausalEvent[],
  turnInputEventId: string
): CausalEvent | undefined =>
  agentEvents.find(
    (event) => event.type === "turn.output.completed" && event.cause_event_ids.includes(turnInputEventId)
  );

const findWake = (
  agentEvents: readonly CausalEvent[],
  triggerEventId: string
): CausalEvent | undefined =>
  agentEvents.find(
    (event) => event.type === "control.wake.accepted" && event.cause_event_ids.includes(triggerEventId)
  );

const buildTrace = (
  agentEvents: readonly CausalEvent[],
  triggerEventId: string,
  memoryWrites: readonly RunMindRow[]
): RunThreadTrace | undefined => {
  const turnInput = findTurnInput(agentEvents, triggerEventId);
  if (!turnInput) return undefined;

  const turnOutput = findTurnOutput(agentEvents, turnInput.event_id);
  const wake = findWake(agentEvents, triggerEventId);

  return {
    inEventId: triggerEventId,
    wakeEventId: wake?.event_id,
    turnInputEventId: turnInput.event_id,
    turnOutputEventId: turnOutput?.event_id,
    turnInputCauses: turnInput.cause_event_ids,
    recalledMemoryEventIds: turnInput.cause_event_ids.filter((causeId) => causeId.startsWith("mneme:")),
    memoryWrites: [...memoryWrites]
  };
};

/**
 * Builds the conversation timeline: the seed message (transcript[0], no
 * trace) followed by every reply, each carrying the causal trace
 * `message -> wake -> turn -> reply` when the reconciled daimon stream for
 * that reply's author resolves one (real ids only — VIEW_DESIGN.md rule 3).
 */
export const computeThread = (
  transcript: RawTranscript,
  events: readonly CausalEvent[],
  mnemeEventsByBank: ReadonlyMap<string, readonly RawMnemeEvent[]>
): RunThreadMessage[] => {
  const rowsByAgent = mindRowsByAgent(mnemeEventsByBank);
  const turnGroupsByAgent = new Map(
    [...rowsByAgent].map(([agentId, rows]) => [agentId, groupMindRowsByTurn(rows)])
  );
  const turnOrdinalByAgent = new Map<string, number>();
  let turnCounter = 0;

  return transcript.transcript.map((message, index) => {
    const isSeed = index === 0;
    const agentId = message.from.type === "agent" ? message.from.id : null;
    const previous = transcript.transcript[index - 1];

    // "woken by @<agentId>" names the @mention in the PRIOR message that
    // caused this agent's wake (the same mention `control.wake.accepted`
    // resolves against) — not that message's author. The seed (index 0) is
    // always the special case: even though it also @mentions the first
    // responder, it is the conversation's opening move, not a reply-trigger.
    const role = isSeed
      ? `${message.from.type} · seed`
      : index === 1
        ? "woken by seed"
        : agentId && previous && extractMentions(previous).includes(agentId)
          ? `woken by @${agentId}`
          : "woken by message";

    const base: RunThreadMessage = {
      messageId: message.id,
      agentId,
      fromName: message.from.name,
      turn: null,
      role,
      createdAt: message.created_at,
      text: messageText(message),
      mentions: extractMentions(message)
    };

    if (isSeed || !agentId || !previous) {
      return base;
    }

    turnCounter += 1;
    const ordinal = (turnOrdinalByAgent.get(agentId) ?? 0) + 1;
    turnOrdinalByAgent.set(agentId, ordinal);

    const memoryWrites = turnGroupsByAgent.get(agentId)?.[ordinal - 1] ?? [];
    const triggerEventId = `moltnet:${previous.id}`;
    const trace = buildTrace(daimonEventsForAgent(events, agentId), triggerEventId, memoryWrites);

    return { ...base, turn: turnCounter, trace };
  });
};

export const computeVerdict = (
  report: SimfileObserveReport,
  artifactIntegrity: readonly ArtifactIntegrityCheck[]
): RunVerdict => {
  const artifactsVerified = artifactIntegrity.filter((check) => check.ok).length;
  return {
    healthy: report.failures.length === 0
      && report.chains.incomplete.length === 0
      && artifactsVerified === artifactIntegrity.length,
    turnCount: report.agent_turns.count,
    chainsComplete: report.chains.complete,
    chainsIncomplete: report.chains.incomplete.length,
    memoryEvents: report.memory.reduce((sum, bank) => sum + bank.events, 0),
    memoryRecalls: report.memory.reduce((sum, bank) => sum + bank.recalls, 0),
    artifactsVerified,
    artifactsTotal: artifactIntegrity.length,
    failures: report.failures.length
  };
};

export const computeProvenance = (
  manifest: SimfileRunManifest,
  report: SimfileObserveReport,
  artifactIntegrity: readonly ArtifactIntegrityCheck[]
): RunViewModel["provenance"] => {
  const okByPath = new Map(artifactIntegrity.map((check) => [check.path, check.ok]));
  const artifacts = manifest.artifacts.map((artifact) => ({
    path: artifact.path,
    sha256: artifact.sha256,
    ok: okByPath.get(artifact.path) ?? false
  }));

  const entries: RunProvenanceEntry[] = [
    { key: "participants", value: report.participants.join(", ") || "—" },
    { key: "turn sequence", value: report.agent_turns.sequence.join(" → ") || "—" },
    { key: "chains complete", value: String(report.chains.complete) },
    { key: "chains incomplete", value: String(report.chains.incomplete.length) },
    { key: "failures", value: String(report.failures.length) },
    { key: "contract", value: report.version }
  ];

  return { artifacts, entries };
};
