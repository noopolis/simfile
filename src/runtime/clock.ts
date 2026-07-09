import { parseDurationSeconds } from "../kernel/duration.js";

interface ParsedPhase {
  id: string;
  startSeconds: number;
}

export interface ClockSpec {
  seed?: string;
  tick: string;
  sim_per_tick?: string;
  phases?: Record<string, string>;
}

export interface ClockRuntime {
  tickSeconds: number;
  simPerTickSeconds: number;
  phases: readonly ParsedPhase[];
}

export interface ResolvedClockState {
  tick: number;
  simTime: number;
  phase: string | undefined;
}

const DAY_SECONDS = 86_400;

const parsePhaseTime = (value: string): number => {
  const normalized = value.trim();
  const [hoursRaw, minutesRaw] = normalized.split(":", 2);
  if (hoursRaw === undefined || minutesRaw === undefined) {
    throw new Error(`invalid phase time: ${value}`);
  }

  const hours = Number(hoursRaw);
  const minutes = Number(minutesRaw);
  if (!Number.isInteger(hours) || !Number.isInteger(minutes) || hours < 0 || hours > 23 || minutes < 0 || minutes > 59) {
    throw new Error(`invalid phase time: ${value}`);
  }

  return hours * 3600 + minutes * 60;
};

export const parseClockSpec = (clock: ClockSpec): ClockRuntime => {
  const tickSeconds = parseDurationSeconds(clock.tick);
  if (tickSeconds <= 0) {
    throw new Error(`clock tick must be positive: ${clock.tick}`);
  }

  const simPerTickSeconds = clock.sim_per_tick ? parseDurationSeconds(clock.sim_per_tick) : tickSeconds;
  if (simPerTickSeconds <= 0) {
    throw new Error(`clock sim_per_tick must be positive: ${clock.sim_per_tick}`);
  }

  const phases = Object.entries(clock.phases ?? {})
    .map(([id, rawStart]) => ({ id, startSeconds: parsePhaseTime(rawStart) }))
    .sort((left, right) => left.startSeconds - right.startSeconds);

  return {
    tickSeconds,
    simPerTickSeconds,
    phases
  };
};

export const resolveClockPhase = (clock: ClockRuntime, simTimeSeconds: number): string | undefined => {
  if (clock.phases.length === 0) {
    return undefined;
  }

  const normalized = ((simTimeSeconds % DAY_SECONDS) + DAY_SECONDS) % DAY_SECONDS;
  const first = clock.phases[0]?.startSeconds ?? 0;
  const rotated = normalized < first ? normalized + DAY_SECONDS : normalized;

  for (let index = 0; index < clock.phases.length; index += 1) {
    const current = clock.phases[index];
    if (!current) {
      continue;
    }
    const next = clock.phases[(index + 1) % clock.phases.length];
    const end = index + 1 === clock.phases.length
      ? next.startSeconds + DAY_SECONDS
      : next.startSeconds;
    if (rotated >= current.startSeconds && rotated < end) {
      return current.id;
    }
  }

  return clock.phases.at(-1)?.id;
};

export const resolveClockState = (clock: ClockRuntime, tick: number): ResolvedClockState => {
  const simTime = tick * clock.simPerTickSeconds;
  return {
    tick,
    simTime,
    phase: resolveClockPhase(clock, simTime)
  };
};
