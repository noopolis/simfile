import type { CausalEvent, ReconcileResult, ReconciliationState } from "@noopolis/stele";

import type { MemoryBankCounts } from "./memoryBanks.js";
import type { SimfileRunManifest } from "./manifest.js";
import { INCOMPLETE_CHAIN_FLAGS, OBSERVE_REPORT_VERSION, type SimfileObserveReport } from "./report.js";

const FAILURE_TYPES = new Set(["turn.failed", "wake.failed"]);
const AGENT_PRINCIPAL_PATTERN = /^agent:(.+)$/u;

const agentIdFromStreamId = (streamId: string): string => streamId.replace(/^agent:/u, "");

/**
 * Orders an agent's `turn.output.completed` events by the moltnet message
 * seq that triggered the underlying turn (never `recorded_at`): each
 * `turn.input.submitted` carries `payload.input_message_ids`, the message
 * event ids that caused it; resolving those back to moltnet's own
 * per-stream `emitter.seq` gives a causal, non-wall-clock ordering.
 */
const triggeringMoltnetSeq = (
  inputEvent: CausalEvent | undefined,
  byEventId: Map<string, CausalEvent>
): number | undefined => {
  const messageIds = inputEvent?.payload.input_message_ids;
  if (!Array.isArray(messageIds)) return undefined;

  let minSeq: number | undefined;
  for (const messageId of messageIds) {
    if (typeof messageId !== "string") continue;
    const message = byEventId.get(messageId);
    if (!message || message.emitter.system !== "moltnet") continue;
    minSeq = minSeq === undefined ? message.emitter.seq : Math.min(minSeq, message.emitter.seq);
  }
  return minSeq;
};

const computeParticipants = (events: readonly CausalEvent[]): string[] => {
  const participants = new Set<string>();
  for (const event of events) {
    const match = AGENT_PRINCIPAL_PATTERN.exec(event.principal_id);
    if (match?.[1]) participants.add(match[1]);
  }
  return [...participants].sort();
};

const computeAgentTurns = (
  events: readonly CausalEvent[]
): { count: number; sequence: string[] } => {
  const byEventId = new Map(events.map((event) => [event.event_id, event]));

  const turnOutputs = events.filter(
    (event) => event.emitter.system === "daimon" && event.type === "turn.output.completed"
  );

  const ordered = turnOutputs
    .map((turnOutput) => {
      const inputEventId = turnOutput.cause_event_ids.find((causeId) => {
        const cause = byEventId.get(causeId);
        return cause?.emitter.system === "daimon" && cause.type === "turn.input.submitted";
      });
      const inputEvent = inputEventId ? byEventId.get(inputEventId) : undefined;
      return {
        agentId: agentIdFromStreamId(turnOutput.emitter.stream_id),
        eventId: turnOutput.event_id,
        seq: triggeringMoltnetSeq(inputEvent, byEventId)
      };
    })
    .sort((left, right) => {
      const leftSeq = left.seq ?? Number.POSITIVE_INFINITY;
      const rightSeq = right.seq ?? Number.POSITIVE_INFINITY;
      return leftSeq - rightSeq || left.eventId.localeCompare(right.eventId);
    });

  return { count: ordered.length, sequence: ordered.map((entry) => entry.agentId) };
};

const computeChains = (
  reconciled: ReconcileResult
): { complete: number; incomplete: { event_id: string; flag: (typeof INCOMPLETE_CHAIN_FLAGS)[number] }[] } => {
  let complete = 0;
  const incomplete: { event_id: string; flag: (typeof INCOMPLETE_CHAIN_FLAGS)[number] }[] = [];

  for (const [eventId, record] of reconciled.byEventId) {
    if (record.state === "complete") {
      complete += 1;
      continue;
    }
    incomplete.push({ event_id: eventId, flag: record.state as Exclude<ReconciliationState, "complete"> });
  }

  incomplete.sort((left, right) => left.event_id.localeCompare(right.event_id));
  return { complete, incomplete };
};

const computeFailures = (events: readonly CausalEvent[]): { reason: string; event_id: string }[] =>
  events
    .filter((event) => FAILURE_TYPES.has(event.type))
    .map((event) => ({
      event_id: event.event_id,
      reason: typeof event.payload.reason === "string" ? event.payload.reason : event.type
    }));

export interface BuildObserveReportInput {
  allEvents: readonly CausalEvent[];
  manifest: SimfileRunManifest;
  memoryBanks: readonly MemoryBankCounts[];
  reconciled: ReconcileResult;
}

export const buildObserveReport = (input: BuildObserveReportInput): SimfileObserveReport => ({
  version: OBSERVE_REPORT_VERSION,
  run_id: input.manifest.run_id,
  contract_versions: input.manifest.contract_versions,
  participants: computeParticipants(input.allEvents),
  agent_turns: computeAgentTurns(input.allEvents),
  chains: computeChains(input.reconciled),
  memory: input.memoryBanks.map((bank) => ({ bank: bank.bank, events: bank.events, recalls: bank.recalls })),
  failures: computeFailures(input.allEvents)
});
