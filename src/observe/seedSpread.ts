import type { CausalEvent } from "@noopolis/stele";

import type { SeedDeclaration } from "./manifest.js";
import type { SeedSpreadChannel, SeedSpreadEntry, SpreadSummary } from "./report.js";
import type { SpreadMnemeEvent, SpreadTranscriptMessage } from "./seedSpreadArtifacts.js";
import {
  matchSeedSpread,
  parseSpreadMatcherPolicy,
  type ParsedSpreadMatcherPolicy,
  type SpreadMatchResult
} from "./spreadMatcher.js";

/**
 * Memetics increment (b): re-derives `seed_spread` from sealed artifacts +
 * `manifest.seed_declaration`, never from the live world loop's own
 * `marker.seen` events (polling order
 * ≠ causal order — see `diffSeedSpreadAgainstLiveMarkerSeen` below for the
 * self-check that DOES read `marker.seen`, but only to report a mismatch,
 * never to feed `seed_spread` itself).
 *
 * Honesty rules enforced here (never hand-waved):
 * - `turn.input.submitted` payloads are never scanned — a token appearing in
 *   an agent's prompt is exposure, not expression.
 * - Any hit whose actor is `world` or `operator:<agent>` is excluded from
 *   `seed_spread` and reported instead as a `failures[]` entry (instrument
 *   error or containment violation, never agent spread).
 * - The one `doc-seeded` entry is taken verbatim from the manifest, never
 *   scanned for.
 */

const AGENT_PRINCIPAL_PATTERN = /^agent:(.+)$/u;

export interface SeedSpreadExcluded {
  event_id: string;
  reason: string;
}

export interface SeedSpreadComputeInput {
  seedDeclaration: SeedDeclaration;
  /** Every collected causal event across every authority, keyed by `event_id` — the
   * cross-stream join surface `deriveTick`'s backward trace walks. */
  causalEventsById: ReadonlyMap<string, CausalEvent>;
  transcriptMessages: readonly SpreadTranscriptMessage[];
  /** Per-bank `raw/mneme/<bank>/causal.jsonl` events, as `observe.ts` already groups them. */
  causalEventsByBank: ReadonlyMap<string, readonly CausalEvent[]>;
  /** Per-bank `raw/mneme/<bank>/events.jsonl` rows (the write-side/interim signal). */
  mnemeEventsByBank: ReadonlyMap<string, readonly SpreadMnemeEvent[]>;
  /** `world/ingested-messages.jsonl`'s `message_id -> tick` join; empty for a non-world-driven run. */
  tickByMoltnetMessageId: ReadonlyMap<string, number>;
}

export interface SeedSpreadComputeResult {
  entries: SeedSpreadEntry[];
  excluded: SeedSpreadExcluded[];
  summary: SpreadSummary;
}

const isInstrumentOrOperatorActor = (actor: string | undefined): boolean =>
  actor === "world" || (actor?.startsWith("operator:") ?? false);

const matchTokenSet = (
  text: string,
  tokenSet: readonly string[],
  matcherPolicy: ParsedSpreadMatcherPolicy
): SpreadMatchResult => matchSeedSpread(text, tokenSet, matcherPolicy);

const agentIdFromPrincipal = (principalId: string): string | undefined =>
  AGENT_PRINCIPAL_PATTERN.exec(principalId)?.[1];

const stringPayloadField = (event: CausalEvent, field: string): string | undefined => {
  const value = (event.payload as Record<string, unknown> | undefined)?.[field];
  return typeof value === "string" ? value : undefined;
};

/**
 * Walks `event_id`'s `cause_event_ids` backward (bounded depth) looking for
 * a `moltnet` `message.accepted` event on each branch — stopping the moment
 * one is found (never recursing past it). Real cause chains only, never a
 * synthesized or wall-clock-ordered link: this is how a `registered`
 * (ledger-path) or `recalled` hit gets an honest `tick` without a direct
 * one-hop join.
 */
const traceBackToMoltnetMessageIds = (
  eventId: string,
  byId: ReadonlyMap<string, CausalEvent>,
  maxDepth = 6
): string[] => {
  const start = byId.get(eventId);
  if (!start) return [];

  const found = new Set<string>();
  const seen = new Set<string>([eventId]);
  const stack: { id: string; depth: number }[] = start.cause_event_ids.map((id) => ({ id, depth: 1 }));

  while (stack.length > 0) {
    const next = stack.pop();
    if (!next || seen.has(next.id) || next.depth > maxDepth) continue;
    seen.add(next.id);

    const event = byId.get(next.id);
    if (!event) continue;

    if (event.emitter.system === "moltnet" && event.type === "message.accepted") {
      found.add(stringPayloadField(event, "message_id") ?? event.event_id);
      continue;
    }
    for (const cause of event.cause_event_ids) stack.push({ id: cause, depth: next.depth + 1 });
  }

  return [...found];
};

const deriveTick = (
  event: CausalEvent | undefined,
  byId: ReadonlyMap<string, CausalEvent>,
  tickByMessageId: ReadonlyMap<string, number>
): number | undefined => {
  if (!event) return undefined;

  if (event.emitter.system === "moltnet" && event.type === "message.accepted") {
    const messageId = stringPayloadField(event, "message_id");
    return messageId ? tickByMessageId.get(messageId) : undefined;
  }

  const ticks = traceBackToMoltnetMessageIds(event.event_id, byId)
    .map((messageId) => tickByMessageId.get(messageId))
    .filter((tick): tick is number => tick !== undefined);
  return ticks.length > 0 ? Math.min(...ticks) : undefined;
};

const docSeededEntry = (seed: SeedDeclaration): SeedSpreadEntry => ({
  channel: "doc-seeded",
  event_id: `doc-seed:${seed.seed_agent}:${seed.seed_epoch}`,
  fidelity: 1,
  agent: seed.seed_agent
});

const computeUtteredEntries = (
  input: SeedSpreadComputeInput,
  matcherPolicy: ParsedSpreadMatcherPolicy
): { entries: SeedSpreadEntry[]; excluded: SeedSpreadExcluded[] } => {
  const entries: SeedSpreadEntry[] = [];
  const excluded: SeedSpreadExcluded[] = [];

  const messageAcceptedByMessageId = new Map<string, CausalEvent>();
  for (const event of input.causalEventsById.values()) {
    if (event.emitter.system !== "moltnet" || event.type !== "message.accepted") continue;
    const messageId = stringPayloadField(event, "message_id");
    if (messageId) messageAcceptedByMessageId.set(messageId, event);
  }

  for (const message of input.transcriptMessages) {
    const match = matchTokenSet(message.text, input.seedDeclaration.token_set, matcherPolicy);
    if (!match.matched) continue;

    const causal = messageAcceptedByMessageId.get(message.id);
    const eventId = causal?.event_id ?? message.id;

    if (isInstrumentOrOperatorActor(message.fromId)) {
      excluded.push({
        event_id: eventId,
        reason: `seed-spread: excluded uttered hit from instrument/operator actor "${message.fromId}" — never counted as agent spread`
      });
      continue;
    }

    entries.push({
      channel: "uttered",
      event_id: eventId,
      fidelity: match.fidelity,
      ...(message.fromId ? { agent: message.fromId } : {}),
      ...(() => {
        const tick = deriveTick(causal, input.causalEventsById, input.tickByMoltnetMessageId);
        return tick === undefined ? {} : { tick };
      })()
    });
  }

  return { entries, excluded };
};

const computeRegisteredEntries = (
  input: SeedSpreadComputeInput,
  matcherPolicy: ParsedSpreadMatcherPolicy
): { entries: SeedSpreadEntry[]; excluded: SeedSpreadExcluded[] } => {
  const entries: SeedSpreadEntry[] = [];
  const excluded: SeedSpreadExcluded[] = [];

  for (const [bank, bankEvents] of input.mnemeEventsByBank) {
    const bankCausal = input.causalEventsByBank.get(bank) ?? [];
    const writtenByMemoryId = new Map<string, CausalEvent>();
    for (const event of bankCausal) {
      if (event.type !== "memory.written") continue;
      const memoryId = stringPayloadField(event, "memory_id");
      if (memoryId) writtenByMemoryId.set(memoryId, event);
    }

    for (const bankEvent of bankEvents) {
      // Recalls get their own channel below, from the causal `memory.recalled`
      // stream — never double-counted here as a registration.
      if (bankEvent.type === "memory.recalled") continue;
      const match = matchTokenSet(bankEvent.text, input.seedDeclaration.token_set, matcherPolicy);
      if (!match.matched) continue;

      const ledgerEvent = writtenByMemoryId.get(bankEvent.id);
      const eventId = ledgerEvent?.event_id ?? bankEvent.id;

      if (isInstrumentOrOperatorActor(bankEvent.agentId)) {
        excluded.push({
          event_id: eventId,
          reason: `seed-spread: excluded registered hit from instrument/operator actor "${bankEvent.agentId}" — never counted as agent spread`
        });
        continue;
      }

      const tick = ledgerEvent ? deriveTick(ledgerEvent, input.causalEventsById, input.tickByMoltnetMessageId) : undefined;
      entries.push({
        channel: "registered",
        event_id: eventId,
        fidelity: match.fidelity,
        ...(bankEvent.agentId ? { agent: bankEvent.agentId } : {}),
        ...(tick === undefined ? {} : { tick }),
        memory_write_source: ledgerEvent ? "ledger" : "events-fallback"
      });
    }
  }

  return { entries, excluded };
};

const computeRecalledEntries = (
  input: SeedSpreadComputeInput,
  matcherPolicy: ParsedSpreadMatcherPolicy
): { entries: SeedSpreadEntry[]; excluded: SeedSpreadExcluded[] } => {
  const entries: SeedSpreadEntry[] = [];
  const excluded: SeedSpreadExcluded[] = [];

  for (const [bank, bankEvents] of input.mnemeEventsByBank) {
    const bankCausal = input.causalEventsByBank.get(bank) ?? [];
    const contentById = new Map(bankEvents.map((event) => [event.id, event.text] as const));

    for (const event of bankCausal) {
      if (event.type !== "memory.recalled") continue;
      const memoryId = stringPayloadField(event, "memory_id");
      const text = memoryId ? contentById.get(memoryId) : undefined;
      if (text === undefined) continue;
      const match = matchTokenSet(text, input.seedDeclaration.token_set, matcherPolicy);
      if (!match.matched) continue;

      const agent = agentIdFromPrincipal(event.principal_id);
      if (isInstrumentOrOperatorActor(agent ?? event.principal_id)) {
        excluded.push({
          event_id: event.event_id,
          reason: `seed-spread: excluded recalled hit from instrument/operator principal "${event.principal_id}" — never counted as agent spread`
        });
        continue;
      }

      const tick = deriveTick(event, input.causalEventsById, input.tickByMoltnetMessageId);
      entries.push({
        channel: "recalled",
        event_id: event.event_id,
        fidelity: match.fidelity,
        ...(agent ? { agent } : {}),
        ...(tick === undefined ? {} : { tick })
      });
    }
  }

  return { entries, excluded };
};

const computeSummary = (entries: readonly SeedSpreadEntry[], seedAgent: string): SpreadSummary => {
  const firstAppearanceByAgent = new Map<string, { channel: SeedSpreadChannel; event_id: string; tick?: number }>();

  for (const entry of entries) {
    if (entry.channel === "doc-seeded" || !entry.agent || entry.agent === seedAgent) continue;
    const existing = firstAppearanceByAgent.get(entry.agent);
    if (!existing) {
      firstAppearanceByAgent.set(entry.agent, { channel: entry.channel, event_id: entry.event_id, tick: entry.tick });
      continue;
    }
    // Prefer whichever appearance carries the lower known tick; keep the
    // first-seen entry when neither (or both equally) carries one.
    if (entry.tick !== undefined && (existing.tick === undefined || entry.tick < existing.tick)) {
      firstAppearanceByAgent.set(entry.agent, { channel: entry.channel, event_id: entry.event_id, tick: entry.tick });
    }
  }

  const firstAppearance = [...firstAppearanceByAgent.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([agent, appearance]) => ({
      agent,
      channel: appearance.channel,
      event_id: appearance.event_id,
      ...(appearance.tick === undefined ? {} : { tick: appearance.tick })
    }));

  const knownTicks = firstAppearance.map((entry) => entry.tick).filter((tick): tick is number => tick !== undefined);

  return {
    reach: firstAppearance.length,
    ...(knownTicks.length > 0 ? { latency: Math.min(...knownTicks) } : {}),
    first_appearance: firstAppearance
  };
};

export const computeSeedSpread = (input: SeedSpreadComputeInput): SeedSpreadComputeResult => {
  // Resolve once before scanning so an unsupported pinned policy fails even
  // when the run has no transcript messages or memory content.
  const matcherPolicy = parseSpreadMatcherPolicy(input.seedDeclaration.matcher_policy);
  const uttered = computeUtteredEntries(input, matcherPolicy);
  const registered = computeRegisteredEntries(input, matcherPolicy);
  const recalled = computeRecalledEntries(input, matcherPolicy);

  const entries = [docSeededEntry(input.seedDeclaration), ...uttered.entries, ...registered.entries, ...recalled.entries];
  const excluded = [...uttered.excluded, ...registered.excluded, ...recalled.excluded];

  return { entries, excluded, summary: computeSummary(entries, input.seedDeclaration.seed_agent) };
};

export interface SeedSpreadSelfCheck {
  /** Moltnet message ids the live world loop's own `marker.seen` flagged. */
  liveHitMessageIds: string[];
  /** Moltnet message ids this module's re-derivation flagged as `uttered` (including excluded ones). */
  derivedHitMessageIds: string[];
  /** Present in the live loop's `marker.seen` set but not re-derived here. */
  onlyLive: string[];
  /** Re-derived here but never flagged by the live loop's `marker.seen`. */
  onlyDerived: string[];
  matches: boolean;
}

/**
 * Diagnostic only, never authoritative: the live loop's `marker.seen` is
 * polling-order, not causal order. Compares the set of Moltnet message ids
 * the live loop flagged
 * against this module's independently re-derived `uttered` hits (both
 * excluded and counted ones — exclusion is instrument hygiene, not evidence
 * the live loop wouldn't have also flagged the same message) and reports
 * any mismatch rather than silently trusting either side.
 */
export const diffSeedSpreadAgainstLiveMarkerSeen = (
  worldEvents: readonly CausalEvent[],
  transcriptMessages: readonly SpreadTranscriptMessage[],
  tokenSet: readonly string[],
  matcherPolicy = "exact"
): SeedSpreadSelfCheck => {
  const parsedMatcherPolicy = parseSpreadMatcherPolicy(matcherPolicy);
  const liveHitMessageIds = [
    ...new Set(
      worldEvents
        .filter((event) => event.type === "marker.seen")
        .map((event) => stringPayloadField(event, "source_event_id"))
        .filter((id): id is string => id !== undefined)
    )
  ].sort();

  const derivedHitMessageIds = [
    ...new Set(
      transcriptMessages
        .filter((message) => matchTokenSet(message.text, tokenSet, parsedMatcherPolicy).matched)
        .map((message) => message.id)
    )
  ].sort();

  const liveSet = new Set(liveHitMessageIds);
  const derivedSet = new Set(derivedHitMessageIds);
  const onlyLive = liveHitMessageIds.filter((id) => !derivedSet.has(id));
  const onlyDerived = derivedHitMessageIds.filter((id) => !liveSet.has(id));

  return { liveHitMessageIds, derivedHitMessageIds, onlyLive, onlyDerived, matches: onlyLive.length === 0 && onlyDerived.length === 0 };
};
