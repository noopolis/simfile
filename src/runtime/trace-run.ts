import { scanMarkers } from "../ledger/markers.js";
import type { Simfile } from "../schema/model.js";
import { parseClockSpec } from "./clock.js";
import { clampAndRound } from "./numeric.js";
import { createTraceEvent, stepSimfileTick } from "./step-tick.js";
import { compileRuntime } from "./trace-compile.js";
import type { RuntimeOptions, RuntimeTrace, RuntimeTraceEvent, RuntimeVariableSample, TransitState } from "./types.js";
import { ingestWorldActs } from "./world-act.js";
import { assertLegacyRuntimeCanExecute } from "./dynamics-guard.js";

const DEFAULT_PRECISION = 6;
const EVENT_FUSE_LIMIT = 5_000;

const validateNonNegativeInteger = (value: number, name: string): void => {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
};

/**
 * Executes a bounded deterministic trace by looping `stepSimfileTick` once
 * per tick (the REFACTOR extraction, Slice memetics-a): all per-tick
 * mechanics — clock resolve, world-act application, generators, derived
 * variables, rules — live in `step-tick.ts` now, so a live driver can call
 * the exact same function once per wall-clock tick instead of only inside
 * this one big batch loop. This function's own job shrinks to setup
 * (compile + initial state + world-act ingestion), the loop itself, and the
 * post-hoc marker scan over the whole run's events — output is unchanged
 * from before the extraction (see `trace.test.ts`, which is untouched).
 */
export const runSimfileTrace = (simfile: Simfile, options: RuntimeOptions): RuntimeTrace => {
  assertLegacyRuntimeCanExecute(simfile, "runSimfileTrace");
  const precision = Math.max(0, Math.floor(options.precision ?? DEFAULT_PRECISION));
  validateNonNegativeInteger(precision, "precision");
  validateNonNegativeInteger(options.ticks, "ticks");

  const clock = parseClockSpec(simfile.clock);
  const runtime = compileRuntime(simfile);
  const presence = { ...runtime.initialPresence };
  const transit = new Map<string, TransitState>();
  const state: Record<string, number> = {};
  for (const [id, value] of Object.entries(runtime.initialState)) {
    const range = runtime.ranges.get(id);
    if (!range) {
      throw new Error(`variable ${id} missing range`);
    }
    state[id] = clampAndRound(value, range, precision);
  }

  const worldActIngestion = ingestWorldActs(options.worldActs ?? [], {
    ticks: options.ticks,
    ranges: runtime.ranges,
    variableFedBy: runtime.variableFedBy
  });

  const events: RuntimeTraceEvent[] = [];
  const samples: RuntimeVariableSample[] = [];
  let seq = 1;
  const emitEvent = (event: RuntimeTraceEvent): void => {
    events.push(event);
    if (events.length > options.ticks * EVENT_FUSE_LIMIT) {
      throw new Error(`event fuse tripped at ${events.length} events`);
    }
  };

  for (let tick = 0; tick < options.ticks; tick += 1) {
    const step = stepSimfileTick(tick, {
      runId: options.runId,
      seed: options.seed,
      precision,
      clock,
      runtime,
      presence,
      transit,
      state,
      seq,
      worldActsForTick: worldActIngestion.queueByTick.get(tick),
      worldActResultsByActId: worldActIngestion.resultsByActId
    });
    seq = step.nextSeq;
    samples.push(step.sample);
    for (const event of step.events) {
      emitEvent(event);
    }
  }

  for (const [markerId, hits] of Object.entries(scanMarkers(events, simfile.markers))) {
    for (const hit of hits) {
      emitEvent(createTraceEvent(options.runId, seq, "marker.seen", hit.simTime, markerId, hit.scope, hit.scope, {
        alias: hit.alias,
        marker: markerId,
        source_event_id: hit.eventId,
        source_event_kind: hit.eventKind
      }, [hit.eventId]));
      seq += 1;
    }
  }

  return {
    runId: options.runId,
    seed: options.seed,
    ticks: options.ticks,
    variables: state,
    events,
    samples,
    diagnostics: [],
    actResults: worldActIngestion.results
  };
};
