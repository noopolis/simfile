import {
  isWorldMessageEvent,
  sendWorldEventToMoltnet
} from "../moltnet/world-participant.js";
import { scanMarkers } from "../ledger/markers.js";
import type { Simfile } from "../schema/model.js";
import { resolveClockState, type ClockRuntime } from "../runtime/clock.js";
import type { CompiledTraceRuntime } from "../runtime/trace-compile.js";
import { ingestWorldActs } from "../runtime/world-act.js";
import { createTraceEvent, stepSimfileTick } from "../runtime/step-tick.js";
import type { RuntimeTraceEvent } from "../runtime/types.js";

import { evaluateExchangeCompletion, type ExchangeEndReason } from "./exchangeWait.js";
import { listMoltnetRoomMessages } from "./moltnetRoomClient.js";
import { ingestNewRoomMessages, moltnetMessageToLedgerEvent } from "./worldTickIngest.js";
import type { WorldLedgerWriter } from "./worldLedgerWriter.js";

export interface LiveTickLoopContext {
  baseUrl: string;
  networkId: string;
  roomId: string;
  roomScope: string;
  agentIds: readonly string[];
  clock: ClockRuntime;
  runtime: CompiledTraceRuntime;
  simfile: Simfile;
  state: Record<string, number>;
  precision: number;
  runId: string;
  seed: string;
  ledgerWriter: WorldLedgerWriter;
  pollOptions: { intervalMs: number; sleep: (ms: number) => Promise<void>; timeoutMs: number };
  targetTurns: number;
  quietGraceMs: number;
  timeoutMs: number;
  maxTicks: number;
}

export interface LiveTickLoopResult {
  endedReason: ExchangeEndReason;
  ticksRun: number;
  markerFired: boolean;
  agentTurnCount: number;
}

/**
 * The live loop itself (memetics increment (a)): one iteration per
 * wall-clock `clock.tick`. Ingest -> step -> scan -> deliver -> append, then
 * decide stop/continue with the same pure `evaluateExchangeCompletion`
 * decision the batch composed driver uses for its own exchange wait — never
 * a coax/resend, per this package's derail-guard rule
 * (`composedOfficeSimDriver.ts`'s own doc comment; unchanged here).
 *
 * - Ingest: `ingestNewRoomMessages` GETs the room and returns only messages
 *   not yet folded into a tick (the cursor IS the determinism contract).
 * - Step: `stepSimfileTick` advances the world exactly one tick (clock
 *   resolve -> world-acts -> generators -> derived -> rules).
 * - Scan: `scanMarkers` runs LIVE over this tick's own newly ingested
 *   messages (never the whole transcript, never the world's own minted
 *   events) so a `marker.seen` hit is always evidence of a REAL agent
 *   utterance. Its `cause_event_ids` is this tick's own `clock.sync` only —
 *   the moltnet message id is carried as `source_event_id` in payload, a
 *   display/measurement join, never a synthesized causal link — so stele
 *   reconciliation over the world stream stays complete.
 * - Deliver: any rule-emitted `world.message`/`world.dm`/`wake.recommended`
 *   from this tick goes out through the existing moltnet world-participant
 *   bridge, unchanged.
 * - Append: the tick's events (plus any minted `marker.seen`), its variable
 *   sample, and the list of ingested message ids all land in
 *   `raw/world/causal.jsonl` / `world/telemetry.json` /
 *   `world/ingested-messages.jsonl` via `ledgerWriter`.
 */
export const runLiveTickLoop = async (ctx: LiveTickLoopContext): Promise<LiveTickLoopResult> => {
  const worldActIngestion = ingestWorldActs([], {
    ticks: ctx.maxTicks,
    ranges: ctx.runtime.ranges,
    variableFedBy: ctx.runtime.variableFedBy
  });

  const cursor = new Set<string>();
  const agentTurns: { id: string }[] = [];
  let seq = 1;
  let markerFired = false;
  const startedAt = Date.now();
  let lastAgentMessageAt = startedAt;

  for (let tick = 0; tick < ctx.maxTicks; tick += 1) {
    const { simTime } = resolveClockState(ctx.clock, tick);

    const { newMessages, ingestedIds } = await ingestNewRoomMessages(
      ctx.baseUrl,
      ctx.roomId,
      cursor,
      listMoltnetRoomMessages
    );

    const step = stepSimfileTick(tick, {
      runId: ctx.runId,
      seed: ctx.seed,
      precision: ctx.precision,
      clock: ctx.clock,
      runtime: ctx.runtime,
      state: ctx.state,
      seq,
      worldActsForTick: worldActIngestion.queueByTick.get(tick),
      worldActResultsByActId: worldActIngestion.resultsByActId
    });
    seq = step.nextSeq;

    const clockSyncEventId = step.events[0]?.event_id;
    if (!clockSyncEventId) {
      throw new Error(`tick ${tick} produced no clock.sync event`);
    }

    const ledgerCandidates = newMessages.map((message) => moltnetMessageToLedgerEvent(message, ctx.roomScope, simTime));
    const hits = scanMarkers(ledgerCandidates, ctx.simfile.markers);
    const markerEvents: RuntimeTraceEvent[] = [];
    for (const [markerId, markerHits] of Object.entries(hits)) {
      for (const hit of markerHits) {
        markerFired = true;
        markerEvents.push(createTraceEvent(
          ctx.runId,
          seq,
          "marker.seen",
          simTime,
          markerId,
          hit.scope,
          hit.scope,
          {
            alias: hit.alias,
            marker: markerId,
            // Display/measurement join to the Moltnet message that carried
            // the token — NOT a synthesized causal link. The real
            // `cause_event_ids` below is this tick's own `clock.sync` only,
            // so stele reconciliation over the world stream stays complete.
            source_event_id: hit.eventId,
            source_event_kind: hit.eventKind
          },
          [clockSyncEventId]
        ));
        seq += 1;
      }
    }

    for (const event of step.events) {
      if (isWorldMessageEvent(event)) {
        await sendWorldEventToMoltnet(event, { baseUrl: ctx.baseUrl, networkId: ctx.networkId });
      }
    }

    await ctx.ledgerWriter.appendTick({
      tick,
      tickEvents: [...step.events, ...markerEvents],
      sample: step.sample,
      ingestedMessageIds: ingestedIds
    });

    for (const message of newMessages) {
      if (ctx.agentIds.includes(message.from.id)) {
        agentTurns.push({ id: message.from.id });
        lastAgentMessageAt = Date.now();
      }
    }

    const evaluation = evaluateExchangeCompletion({
      agentTurnCount: agentTurns.length,
      elapsedSinceLastAgentMessageMs: Date.now() - lastAgentMessageAt,
      elapsedSinceStartMs: Date.now() - startedAt,
      quietGraceMs: ctx.quietGraceMs,
      targetTurns: ctx.targetTurns,
      timeoutMs: ctx.timeoutMs
    });
    if (evaluation.done) {
      return {
        endedReason: evaluation.reason as ExchangeEndReason,
        ticksRun: tick + 1,
        markerFired,
        agentTurnCount: agentTurns.length
      };
    }

    await ctx.pollOptions.sleep(ctx.pollOptions.intervalMs);
  }

  throw new Error(`world tick fuse tripped at ${ctx.maxTicks} ticks without the exchange concluding`);
};
