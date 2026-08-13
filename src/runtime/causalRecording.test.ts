import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  assertCausalRecording,
  createCausalRecorder,
  decodeRecordedBytes,
  type CausalRecording,
} from "./causalRecording.js";
import { canonicalCausalRecordingJson } from "./causalRecordingJson.js";
import {
  replayCausalRecording,
  replayCausalRecordingSegments,
  type CausalReplayAdapter,
} from "./causalReplay.js";

const UTF8 = new TextEncoder();
const bytes = (value: unknown): Uint8Array => UTF8.encode(JSON.stringify(value));
const sha = (letter: string): string => letter.repeat(64);
const config = () => ({
  run_id: "run-1",
  tick_duration_ns: 20_000_000,
  identity: {
    seed: "seed-1",
    config_sha256: sha("1"),
    artifact_sha256: sha("2"),
    runtime_sha256: sha("3"),
    reducer_sha256: sha("4"),
  },
  ports: [
    { port_id: "world.agent", owner: "daimon", minimum_exchanges: 1 },
    { port_id: "world.nudge", owner: "moltnet", minimum_exchanges: 0 },
  ],
  initial_state: bytes({ value: 0 }),
} as const);

const exchange = (tick: number, correlation = `call-${tick}`) => ({
  issued_tick: tick,
  issued_sim_time_ns: tick * 20_000_000,
  port_id: "world.agent",
  flow: "into_world" as const,
  operation: "act",
  principal_id: "agent:red",
  correlation_id: correlation,
  causal_ids: [],
  request: bytes({ add: 2 }),
});
const timing = (tick: number) => ({
  received_tick: tick,
  received_sim_time_ns: tick * 20_000_000,
});

const complete = (): CausalRecording => {
  const recorder = createCausalRecorder(config());
  recorder.begin(exchange(1)).response({ ...timing(1), status: 202, response: bytes({ queued: true }), chunks: [bytes("chunk")] });
  recorder.checkpoint({ tick: 2, state: bytes({ value: 2 }) });
  recorder.begin(exchange(3)).error({ ...timing(3), code: "provider_error", error: bytes({ message: "captured" }) });
  recorder.closePort("world.agent");
  recorder.closePort("world.nudge");
  return recorder.finalize({ tick: 4, reason: "completed", state: bytes({ value: 4 }) });
};

test("records exact opaque boundary bytes, identities, checkpoints, and terminal state", () => {
  const recording = complete();
  assert.equal(assertCausalRecording(recording), recording);
  assert.deepEqual(JSON.parse(new TextDecoder().decode(decodeRecordedBytes(recording.events[0]!.request))), { add: 2 });
  assert.equal(recording.events[0]!.outcome.kind, "response");
  assert.equal(recording.events[1]!.outcome.kind, "error");
  assert.deepEqual(recording.closed_ports, ["world.agent", "world.nudge"]);
  assert.match(recording.recording_sha256, /^[a-f0-9]{64}$/u);
});

test("preserves checkpoints larger than dynamics JSON budgets", () => {
  const initialState = Uint8Array.from({ length: 100_000 }, (_, index) => index % 251);
  const recorder = createCausalRecorder({
    run_id: "large-state",
    tick_duration_ns: 10,
    identity: config().identity,
    ports: [{ port_id: "world.tools", owner: "agent", minimum_exchanges: 0 }],
    initial_state: initialState,
  });
  recorder.checkpoint({ tick: 1, state: initialState });
  recorder.closePort("world.tools");
  const recording = recorder.finalize({ tick: 1, reason: "complete", state: initialState });
  assert.deepEqual(decodeRecordedBytes(assertCausalRecording(recording).terminal.state), initialState);
});

test("fails closed for missing capture completion, port closure, duplicate ids, reorder, and unknown ports", () => {
  const open = createCausalRecorder(config());
  open.begin(exchange(1));
  assert.throws(() => open.finalize({ tick: 2, reason: "completed", state: bytes({}) }), /incomplete/u);
  const missingPort = createCausalRecorder(config());
  missingPort.closePort("world.agent");
  missingPort.closePort("world.nudge");
  assert.throws(() => missingPort.finalize({ tick: 0, reason: "completed", state: bytes({}) }), /incomplete/u);
  const duplicate = createCausalRecorder(config());
  duplicate.begin(exchange(1, "same")).timeout(timing(1));
  assert.throws(() => duplicate.begin(exchange(2, "same")).cancel(timing(2)), /invalid causal boundary/u);
  const reorder = createCausalRecorder(config());
  reorder.begin(exchange(2)).timeout(timing(2));
  assert.throws(() => reorder.begin(exchange(1)).timeout(timing(1)), /invalid causal boundary/u);
  assert.throws(() => reorder.closePort("world.agent"), /unavailable/u);
  assert.throws(() => reorder.finalize({ tick: 3, reason: "completed", state: bytes({}) }), /incomplete/u);
  assert.throws(() => createCausalRecorder(config()).begin({ ...exchange(1), port_id: "unknown" }), /undeclared/u);
});

test("rejects corrupt bytes, hashes, sequence, checkpoint ordering, and runtime identity", () => {
  const mutations: ((value: any) => void)[] = [
    (value) => { value.events[0].request.data = "AAAA"; },
    (value) => { value.events[0].request.sha256 = sha("0"); },
    (value) => { value.events[0].sequence = 7; },
    (value) => { value.checkpoints[0].tick = 0; },
    (value) => { value.checkpoints[0].event_sequence = 0; },
    (value) => { value.terminal.event_sequence = 1; },
    (value) => { value.identity.runtime_sha256 = sha("9"); },
    (value) => { value.recording_sha256 = sha("f"); },
  ];
  for (const mutate of mutations) {
    const value = structuredClone(complete());
    mutate(value);
    assert.throws(() => assertCausalRecording(value));
  }
});

test("rejects unknown recording fields even when an attacker re-signs the document", () => {
  const resign = (value: any): void => {
    const { recording_sha256: _prior, ...unsigned } = value;
    value.recording_sha256 = createHash("sha256")
      .update(canonicalCausalRecordingJson(unsigned))
      .digest("hex");
  };
  for (const mutate of [
    (value: any) => { value.events[0].invented = true; },
    (value: any) => { value.events[0].outcome.invented = true; },
    (value: any) => { value.events[0].request.invented = true; },
    (value: any) => { value.identity.invented = true; },
    (value: any) => { value.ports[0].invented = true; },
    (value: any) => { value.checkpoints[0].invented = true; },
  ]) {
    const value = structuredClone(complete());
    mutate(value);
    resign(value);
    assert.throws(() => assertCausalRecording(value), /invalid/u);
  }
  const recorder = createCausalRecorder(config());
  assert.throws(
    () => recorder.begin({ ...exchange(1), invented: true } as never),
    /invalid/u,
  );
});

test("replays from start or nearest checkpoint without any provider/network callback", () => {
  const recorder = createCausalRecorder(config());
  recorder.begin(exchange(0, "first")).response({ ...timing(0), status: 200, response: bytes({}) });
  recorder.checkpoint({ tick: 1, state: bytes({ value: 3 }) });
  recorder.begin(exchange(2, "second")).response({ ...timing(2), status: 200, response: bytes({}) });
  recorder.closePort("world.agent");
  recorder.closePort("world.nudge");
  const recording = recorder.finalize({ tick: 3, reason: "completed", state: bytes({ value: 7 }) });
  let state = { value: 0 };
  const adapter: CausalReplayAdapter = {
    restore: (raw) => { state = JSON.parse(new TextDecoder().decode(raw)); },
    inject: (event) => { state.value += JSON.parse(new TextDecoder().decode(decodeRecordedBytes(event.request))).add; },
    step: () => { state.value += 1; },
    snapshot: () => bytes(state),
  };
  const result = replayCausalRecording({ recording, adapter });
  assert.equal(result.terminal, true);
  assert.equal(result.injected_events, 2);
  assert.equal(state.value, 7);
  const sought = replayCausalRecording({ recording, adapter, seek_tick: 2 });
  assert.equal(sought.terminal, false);
  assert.equal(state.value, 4);
});

test("seek restores the exact same-tick event frontier and rejects time travel", () => {
  const recorder = createCausalRecorder(config());
  recorder.begin(exchange(1, "before-checkpoint")).response({
    ...timing(2),
    status: 200,
    response: bytes({}),
  });
  recorder.checkpoint({ tick: 2, state: bytes({ value: 4 }) });
  recorder.begin(exchange(2, "after-checkpoint")).response({
    ...timing(2),
    status: 200,
    response: bytes({}),
  });
  const timeTravel = createCausalRecorder(config());
  timeTravel.begin(exchange(1, "first")).timeout(timing(2));
  timeTravel.checkpoint({ tick: 3, state: bytes({ value: 0 }) });
  assert.throws(
    () => timeTravel.begin(exchange(1, "time-travel")).timeout(timing(1)),
    /invalid causal boundary/u,
  );
  recorder.closePort("world.agent");
  recorder.closePort("world.nudge");
  const recording = recorder.finalize({
    tick: 3,
    reason: "completed",
    state: bytes({ value: 7 }),
  });
  assert.equal(recording.checkpoints[0]!.event_sequence, 1);
  let state = { value: 0 };
  const adapter: CausalReplayAdapter = {
    restore: (raw) => { state = JSON.parse(new TextDecoder().decode(raw)); },
    inject: () => { state.value += 2; },
    step: () => { state.value += 1; },
    snapshot: () => bytes(state),
  };
  replayCausalRecording({ recording, adapter, seek_tick: 2 });
  assert.equal(state.value, 4);
  replayCausalRecording({ recording, adapter });
  assert.equal(state.value, 7);
});

test("segmented replay covers every event from the initial checkpoint with fresh adapters", async () => {
  const recorder = createCausalRecorder(config());
  recorder.begin(exchange(0, "first")).response({
    ...timing(0),
    status: 200,
    response: bytes({}),
  });
  recorder.checkpoint({ tick: 1, state: bytes({ value: 3 }) });
  recorder.begin(exchange(2, "second")).response({
    ...timing(2),
    status: 200,
    response: bytes({}),
  });
  recorder.closePort("world.agent");
  recorder.closePort("world.nudge");
  const recording = recorder.finalize({
    tick: 3,
    reason: "completed",
    state: bytes({ value: 7 }),
  });
  let adapters = 0;
  const createAdapter = (): CausalReplayAdapter => {
    adapters += 1;
    let state = { value: 0 };
    return {
      restore: (raw) => { state = JSON.parse(new TextDecoder().decode(raw)); },
      inject: (event) => {
        state.value += JSON.parse(
          new TextDecoder().decode(decodeRecordedBytes(event.request)),
        ).add;
      },
      step: () => { state.value += 1; },
      snapshot: () => bytes(state),
    };
  };
  const result = await replayCausalRecordingSegments({
    recording,
    create_adapter: createAdapter,
  });
  assert.equal(adapters, 2);
  assert.equal(result.segments, 2);
  assert.equal(result.injected_events, recording.events.length);
  assert.equal(result.state_sha256, recording.terminal.state.sha256);
  assert.throws(
    () => replayCausalRecording({
      recording,
      adapter: createAdapter(),
      start_tick: 2,
      seek_tick: 3,
    }),
    /start checkpoint/u,
  );
});

test("detects checkpoint and terminal divergence", () => {
  const recording = complete();
  let state = bytes({ value: 0 });
  const adapter: CausalReplayAdapter = {
    restore: (raw) => { state = raw; },
    inject: () => {},
    step: () => { state = bytes({ value: 999 }); },
    snapshot: () => state,
  };
  assert.throws(() => replayCausalRecording({ recording, adapter }), /diverged/u);
});
