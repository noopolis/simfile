import { createHash } from "node:crypto";

import {
  assertCausalRecording,
  decodeRecordedBytes,
  type CausalBoundaryExchange,
  type CausalRecording,
  type CausalRecordingCheckpoint,
} from "./causalRecording.js";

export interface CausalReplayAdapter {
  restore(state: Uint8Array): void;
  inject(exchange: CausalBoundaryExchange): void;
  step(tick: number): void;
  snapshot(): Uint8Array;
}

export interface CausalReplayResult {
  readonly tick: number;
  readonly state_sha256: string;
  readonly terminal: boolean;
  readonly injected_events: number;
}

export interface CausalSegmentedReplayResult extends CausalReplayResult {
  readonly segments: number;
}

const hash = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const assertState = (adapter: CausalReplayAdapter, expected: CausalRecordingCheckpoint): void => {
  const actual = adapter.snapshot();
  if (!(actual instanceof Uint8Array) || hash(actual) !== expected.state.sha256
    || actual.byteLength !== expected.state.byte_length) throw new Error(`causal replay diverged at tick ${expected.tick}`);
};

export const replayCausalRecording = (input: {
  readonly recording: CausalRecording;
  readonly adapter: CausalReplayAdapter;
  /** Restore this exact authenticated checkpoint instead of selecting the nearest one. */
  readonly start_tick?: number;
  readonly seek_tick?: number;
}): CausalReplayResult => {
  const recording = assertCausalRecording(input.recording);
  const target = input.seek_tick ?? recording.terminal.tick;
  if (!Number.isSafeInteger(target) || target < 0 || target > recording.terminal.tick) throw new TypeError("invalid causal replay seek");
  const available = [recording.initial_checkpoint, ...recording.checkpoints]
    .filter(({ tick }) => tick <= target)
    .sort((left, right) => left.tick - right.tick);
  const start = input.start_tick === undefined
    ? input.seek_tick === undefined
      ? recording.initial_checkpoint
      : available.at(-1)!
    : available.find(({ tick }) => tick === input.start_tick);
  if (start === undefined || start.tick > target) {
    throw new TypeError("invalid causal replay start checkpoint");
  }
  input.adapter.restore(decodeRecordedBytes(start.state));
  assertState(input.adapter, start);
  let injected = 0;
  let eventIndex = start.event_sequence;
  const expectedByTick = new Map(recording.checkpoints.map((checkpoint) => [checkpoint.tick, checkpoint]));
  const injectToFrontier = (tick: number, frontier: number): void => {
    while (eventIndex < frontier) {
      const event = recording.events[eventIndex];
      if (event === undefined || event.tick !== tick) {
        throw new Error(`causal replay checkpoint frontier drift at tick ${tick}`);
      }
      input.adapter.inject(event);
      eventIndex += 1;
      injected += 1;
    }
  };
  for (let tick = start.tick; tick < target; tick += 1) {
    const expected = expectedByTick.get(tick);
    if (expected !== undefined && expected !== start) {
      injectToFrontier(tick, expected.event_sequence);
      assertState(input.adapter, expected);
    }
    while (eventIndex < recording.events.length && recording.events[eventIndex]!.tick === tick) {
      input.adapter.inject(recording.events[eventIndex]!);
      eventIndex += 1;
      injected += 1;
    }
    input.adapter.step(tick);
  }
  const targetCheckpoint = expectedByTick.get(target);
  if (targetCheckpoint !== undefined && targetCheckpoint !== start) {
    injectToFrontier(target, targetCheckpoint.event_sequence);
    assertState(input.adapter, targetCheckpoint);
  }
  if (target === recording.terminal.tick) {
    while (eventIndex < recording.events.length && recording.events[eventIndex]!.tick === target) {
      input.adapter.inject(recording.events[eventIndex]!);
      eventIndex += 1;
      injected += 1;
    }
  }
  const state = input.adapter.snapshot();
  if (!(state instanceof Uint8Array)) throw new TypeError("invalid causal replay snapshot");
  if (target === recording.terminal.tick && hash(state) !== recording.terminal.state.sha256) {
    throw new Error(`causal replay diverged at terminal tick ${target}`);
  }
  return Object.freeze({
    tick: target,
    state_sha256: hash(state),
    terminal: target === recording.terminal.tick,
    injected_events: injected,
  });
};

/**
 * Replays every authenticated checkpoint interval exactly once. A fresh adapter
 * per interval bounds stateful reducer resources without weakening the proof to
 * a terminal-checkpoint restore.
 */
export const replayCausalRecordingSegments = async (input: {
  readonly recording: CausalRecording;
  readonly create_adapter: () => CausalReplayAdapter | Promise<CausalReplayAdapter>;
}): Promise<CausalSegmentedReplayResult> => {
  const recording = assertCausalRecording(input.recording);
  const targets = [...new Set([
    ...recording.checkpoints.map(({ tick }) => tick),
    recording.terminal.tick,
  ])].sort((left, right) => left - right);
  let startTick = recording.initial_checkpoint.tick;
  let injectedEvents = 0;
  let final: CausalReplayResult | undefined;
  for (const target of targets) {
    const adapter = await input.create_adapter();
    final = replayCausalRecording({
      recording,
      adapter,
      start_tick: startTick,
      seek_tick: target,
    });
    injectedEvents += final.injected_events;
    startTick = target;
  }
  if (final === undefined || !final.terminal
    || injectedEvents !== recording.events.length) {
    throw new Error("causal segmented replay did not cover the complete recording");
  }
  return Object.freeze({
    ...final,
    injected_events: injectedEvents,
    segments: targets.length,
  });
};
