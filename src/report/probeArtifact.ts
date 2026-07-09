import type { LedgerEvent } from "../ledger/markers.js";

export interface ProbeSample {
  evidence_id?: string;
  event_id?: string;
  tick?: number;
  sim_time?: number;
  phase?: string;
  variables?: Record<string, number>;
}

export interface ProbeArtifact {
  events: readonly LedgerEvent[];
  samples?: readonly ProbeSample[];
}

export interface ProbeOccurrence {
  evidenceId: string;
  simTime?: number;
  tick?: number;
  phase?: string;
  variables?: Readonly<Record<string, number>>;
  event?: LedgerEvent;
}

interface ClockSample {
  evidenceId: string;
  tick?: number;
  simTime?: number;
  phase?: string;
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

const evidenceId = (event: LedgerEvent, fallbackIndex: number): string => event.event_id ?? `index:${fallbackIndex}`;

const clockSampleFromEvent = (event: LedgerEvent, index: number): ClockSample | undefined => {
  if (event.kind !== "clock.sync" || !isObject(event.payload)) {
    return undefined;
  }

  const payload = event.payload;
  const tick = typeof payload.tick === "number" && Number.isFinite(payload.tick) ? payload.tick : undefined;
  const simTime = typeof event.sim_time === "number" && Number.isFinite(event.sim_time)
    ? event.sim_time
    : typeof payload.sim_time === "number" && Number.isFinite(payload.sim_time)
      ? payload.sim_time
      : undefined;
  const phase = typeof payload.phase === "string" ? payload.phase : undefined;

  return {
    evidenceId: evidenceId(event, index),
    tick,
    simTime,
    phase
  };
};

const explicitSampleId = (sample: ProbeSample, index: number): string => sample.evidence_id ?? sample.event_id ?? `sample:${index}`;

export const normalizeProbeArtifact = (input: readonly LedgerEvent[] | ProbeArtifact): ProbeArtifact => {
  if (Array.isArray(input)) {
    return { events: input, samples: [] };
  }
  const artifact = input as ProbeArtifact;
  return { events: artifact.events, samples: artifact.samples ?? [] };
};

export const buildSampleOccurrences = (
  events: readonly LedgerEvent[],
  explicitSamples: readonly ProbeSample[]
): ProbeOccurrence[] => {
  const clockSamples = events
    .map((event, index) => clockSampleFromEvent(event, index))
    .filter((sample): sample is ClockSample => sample !== undefined);

  const explicitByTick = new Map<number, { sample: ProbeSample; index: number }>();
  const explicitByEvidence = new Map<string, { sample: ProbeSample; index: number }>();
  const matchedExplicit = new Set<number>();

  explicitSamples.forEach((sample, index) => {
    if (sample.tick !== undefined && !explicitByTick.has(sample.tick)) {
      explicitByTick.set(sample.tick, { sample, index });
    }
    const sampleId = explicitSampleId(sample, index);
    if (!explicitByEvidence.has(sampleId)) {
      explicitByEvidence.set(sampleId, { sample, index });
    }
  });

  const normalized: ProbeOccurrence[] = clockSamples.map((clockSample) => {
    const byEvidence = explicitByEvidence.get(clockSample.evidenceId);
    const byTick = clockSample.tick !== undefined ? explicitByTick.get(clockSample.tick) : undefined;
    const explicit = byEvidence ?? byTick;
    if (explicit) {
      matchedExplicit.add(explicit.index);
    }
    return {
      evidenceId: explicit ? explicitSampleId(explicit.sample, explicit.index) : clockSample.evidenceId,
      tick: explicit?.sample.tick ?? clockSample.tick,
      simTime: explicit?.sample.sim_time ?? clockSample.simTime,
      phase: explicit?.sample.phase ?? clockSample.phase,
      variables: explicit?.sample.variables
    };
  });

  explicitSamples.forEach((sample, index) => {
    if (matchedExplicit.has(index)) {
      return;
    }
    normalized.push({
      evidenceId: explicitSampleId(sample, index),
      tick: sample.tick,
      simTime: sample.sim_time,
      phase: sample.phase,
      variables: sample.variables
    });
  });

  return normalized.sort((left, right) => {
    const leftTick = left.tick ?? Number.MAX_SAFE_INTEGER;
    const rightTick = right.tick ?? Number.MAX_SAFE_INTEGER;
    if (leftTick !== rightTick) {
      return leftTick - rightTick;
    }
    const leftTime = left.simTime ?? Number.MAX_SAFE_INTEGER;
    const rightTime = right.simTime ?? Number.MAX_SAFE_INTEGER;
    return leftTime - rightTime;
  });
};

export const buildEventOccurrences = (events: readonly LedgerEvent[]): ProbeOccurrence[] => {
  const occurrences: ProbeOccurrence[] = [];
  let activeTick: number | undefined;
  let activePhase: string | undefined;
  let activeSimTime: number | undefined;

  events.forEach((event, index) => {
    const clockSample = clockSampleFromEvent(event, index);
    if (clockSample) {
      activeTick = clockSample.tick;
      activePhase = clockSample.phase;
      activeSimTime = clockSample.simTime;
    }

    occurrences.push({
      evidenceId: evidenceId(event, index),
      simTime: event.sim_time ?? activeSimTime,
      tick: activeTick,
      phase: activePhase,
      event
    });
  });

  return occurrences;
};

export const attachVariablesToEventOccurrences = (
  events: readonly ProbeOccurrence[],
  samples: readonly ProbeOccurrence[]
): ProbeOccurrence[] => {
  const sampleByTick = new Map<number, ProbeOccurrence>();
  samples.forEach((sample) => {
    if (sample.tick !== undefined && !sampleByTick.has(sample.tick)) {
      sampleByTick.set(sample.tick, sample);
    }
  });

  return events.map((event) => ({
    ...event,
    variables: event.tick !== undefined ? sampleByTick.get(event.tick)?.variables : undefined,
    phase: event.tick !== undefined ? sampleByTick.get(event.tick)?.phase ?? event.phase : event.phase,
    simTime: event.tick !== undefined ? sampleByTick.get(event.tick)?.simTime ?? event.simTime : event.simTime
  }));
};
