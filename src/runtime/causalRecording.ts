import { createHash } from "node:crypto";

import { canonicalCausalRecordingJson } from "./causalRecordingJson.js";
import {
  CAUSAL_RECORDING_LIMITS,
  CAUSAL_RECORDING_VERSION,
  type BoundaryCompletionTiming,
  type BoundaryExchangeInput,
  type CausalBoundaryOutcome,
  type CausalBoundaryExchange,
  type CausalBoundaryReservation,
  type CausalRecorder,
  type CausalRecording,
  type CausalRecordingCheckpoint,
  type CausalRecordingIdentity,
  type CausalRecordingPort,
  type RecordedBytes,
} from "./causalRecordingContract.js";

export * from "./causalRecordingContract.js";

const SHA256 = /^[a-f0-9]{64}$/u;
const ID = /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,255}$/u;
const UTF8 = new TextEncoder();
const exactKeys = (
  value: unknown,
  expected: readonly string[],
): boolean => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const keys = Reflect.ownKeys(value);
  return keys.length === expected.length
    && keys.every((key) => typeof key === "string" && expected.includes(key));
};

const hash = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const recordedBytes = (input: Uint8Array): RecordedBytes => {
  if (!(input instanceof Uint8Array) || input.byteLength > CAUSAL_RECORDING_LIMITS.bytes) throw new TypeError("invalid recorded bytes");
  const copy = Uint8Array.from(input);
  const value: RecordedBytes = {
    encoding: "base64",
    byte_length: copy.byteLength,
    sha256: hash(copy),
    data: Buffer.from(copy).toString("base64"),
  };
  return Object.freeze(value);
};

export const decodeRecordedBytes = (input: RecordedBytes): Uint8Array => {
  if (!exactKeys(input, ["encoding", "byte_length", "sha256", "data"])
    || input?.encoding !== "base64" || !Number.isSafeInteger(input.byte_length) || input.byte_length < 0
    || input.byte_length > CAUSAL_RECORDING_LIMITS.bytes || typeof input.sha256 !== "string" || !SHA256.test(input.sha256)
    || typeof input.data !== "string") throw new TypeError("invalid recorded bytes");
  const bytes = Uint8Array.from(Buffer.from(input.data, "base64"));
  if (bytes.byteLength !== input.byte_length || Buffer.from(bytes).toString("base64") !== input.data || hash(bytes) !== input.sha256) {
    throw new TypeError("corrupt recorded bytes");
  }
  return bytes;
};

const validId = (value: unknown): value is string => typeof value === "string" && ID.test(value);
const validSha = (value: unknown): value is string => typeof value === "string" && SHA256.test(value);
const timeFor = (tick: number, duration: number): number => {
  if (!Number.isSafeInteger(tick) || tick < 0) throw new TypeError("invalid recording tick");
  const value = tick * duration;
  if (!Number.isSafeInteger(value)) throw new TypeError("recording time overflow");
  return value;
};
const canonicalHash = (value: Omit<CausalRecording, "recording_sha256">): string =>
  hash(UTF8.encode(canonicalCausalRecordingJson(value)));
const freeze = <T>(value: T): T => {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as object)) freeze(child);
    Object.freeze(value);
  }
  return value;
};

export const createCausalRecorder = (input: {
  readonly run_id: string;
  readonly tick_duration_ns: number;
  readonly identity: CausalRecordingIdentity;
  readonly ports: readonly CausalRecordingPort[];
  readonly initial_state: Uint8Array;
}): CausalRecorder => {
  if (!exactKeys(input.identity, [
    "seed", "config_sha256", "artifact_sha256", "runtime_sha256",
    "reducer_sha256",
  ])
    || !validId(input.run_id) || !Number.isSafeInteger(input.tick_duration_ns) || input.tick_duration_ns <= 0
    || input.ports.length === 0 || input.ports.length > CAUSAL_RECORDING_LIMITS.ports
    || !validId(input.identity.seed) || !validSha(input.identity.config_sha256)
    || !validSha(input.identity.artifact_sha256) || !validSha(input.identity.runtime_sha256)
    || !validSha(input.identity.reducer_sha256)) throw new TypeError("invalid causal recorder configuration");
  const ports = [...input.ports].map((port) => ({ ...port }))
    .sort((left, right) => left.port_id.localeCompare(right.port_id));
  if (ports.some(({ port_id, owner }, index) =>
    !exactKeys(ports[index], ["port_id", "owner", "minimum_exchanges"])
    || !validId(port_id) || !validId(owner)
    || !Number.isSafeInteger(ports[index]!.minimum_exchanges)
    || ports[index]!.minimum_exchanges < 0
    || ports[index]!.minimum_exchanges > CAUSAL_RECORDING_LIMITS.events
    || (index > 0 && ports[index - 1]!.port_id === port_id))) throw new TypeError("invalid causal recorder ports");
  const declared = new Set(ports.map(({ port_id }) => port_id));
  const exchangeCounts = new Map(ports.map(({ port_id }) => [port_id, 0]));
  const closed = new Set<string>();
  const correlations = new Set<string>();
  const events: CausalBoundaryExchange[] = [];
  const checkpoints: CausalRecordingCheckpoint[] = [];
  const open = new Set<object>();
  let timelineTick = 0;
  let finalized = false;
  const ensureOpen = (): void => { if (finalized) throw new Error("causal recorder is finalized"); };
  const append = (
    inputEvent: BoundaryExchangeInput,
    timing: BoundaryCompletionTiming,
    outcome: CausalBoundaryOutcome,
    token: object,
  ): void => {
    ensureOpen();
    if (!open.has(token)) throw new Error("boundary reservation is closed");
    const event = {
      ...inputEvent,
      tick: timing.received_tick,
      sim_time_ns: timing.received_sim_time_ns,
      received_tick: timing.received_tick,
      received_sim_time_ns: timing.received_sim_time_ns,
    };
    if (event.tick < timelineTick || !declared.has(event.port_id) || closed.has(event.port_id)
      || !validId(event.operation) || !validId(event.principal_id) || !validId(event.correlation_id)
      || correlations.has(`${event.port_id}\0${event.correlation_id}`)
      || !Array.isArray(event.causal_ids) || new Set(event.causal_ids).size !== event.causal_ids.length
      || event.causal_ids.some((id) => !validId(id))
      || !["into_world", "out_of_world"].includes(event.flow)
      || event.sim_time_ns !== timeFor(event.tick, input.tick_duration_ns)
      || event.issued_sim_time_ns !== timeFor(event.issued_tick, input.tick_duration_ns)
      || event.received_sim_time_ns !== timeFor(event.received_tick, input.tick_duration_ns)
      || event.issued_tick > event.received_tick) {
      throw new TypeError("invalid causal boundary exchange");
    }
    if (events.length >= CAUSAL_RECORDING_LIMITS.events) throw new Error("causal recording event limit exceeded");
    open.delete(token);
    correlations.add(`${event.port_id}\0${event.correlation_id}`);
    timelineTick = event.tick;
    exchangeCounts.set(event.port_id, exchangeCounts.get(event.port_id)! + 1);
    events.push(freeze({ ...event, sequence: events.length + 1, request: recordedBytes(event.request), outcome }));
  };
  const recorder: CausalRecorder = {
    begin: (event: BoundaryExchangeInput): CausalBoundaryReservation => {
      ensureOpen();
      if (!exactKeys(event, [
        "issued_tick", "issued_sim_time_ns", "port_id", "flow", "operation",
        "principal_id", "correlation_id", "causal_ids", "request",
      ])) throw new TypeError("invalid causal boundary exchange input");
      if (!declared.has(event.port_id) || closed.has(event.port_id)) throw new Error("undeclared or closed causal port");
      const token = {};
      open.add(token);
      let done = false;
      const finish = (timing: BoundaryCompletionTiming, outcome: CausalBoundaryOutcome): void => {
        if (done) throw new Error("boundary reservation is closed");
        done = true;
        append(event, timing, outcome, token);
      };
      return Object.freeze({
        response: (completion: BoundaryCompletionTiming & { readonly status: number; readonly response: Uint8Array; readonly chunks?: readonly Uint8Array[] }) => {
          const { status, response, chunks = [], ...timing } = completion;
          if (!Number.isSafeInteger(status) || status < 0 || status > 999 || !Array.isArray(chunks)
            || !exactKeys(completion,
              Object.hasOwn(completion, "chunks")
                ? ["received_tick", "received_sim_time_ns", "status", "response", "chunks"]
                : ["received_tick", "received_sim_time_ns", "status", "response"])) throw new TypeError("invalid boundary response");
          finish(timing, freeze({ kind: "response", status, response: recordedBytes(response), chunks: chunks.map(recordedBytes) }));
        },
        error: (completion: BoundaryCompletionTiming & { readonly code: string; readonly error: Uint8Array }) => {
          const { code, error, ...timing } = completion;
          if (!exactKeys(completion, [
            "received_tick", "received_sim_time_ns", "code", "error",
          ]) || !validId(code)) throw new TypeError("invalid boundary error");
          finish(timing, freeze({ kind: "error", code, error: recordedBytes(error) }));
        },
        timeout: (timing: BoundaryCompletionTiming) => {
          if (!exactKeys(timing, ["received_tick", "received_sim_time_ns"])) {
            throw new TypeError("invalid boundary timeout");
          }
          finish(timing, Object.freeze({ kind: "timeout" }));
        },
        cancel: (timing: BoundaryCompletionTiming) => {
          if (!exactKeys(timing, ["received_tick", "received_sim_time_ns"])) {
            throw new TypeError("invalid boundary cancellation");
          }
          finish(timing, Object.freeze({ kind: "cancelled" }));
        },
      });
    },
    checkpoint: ({ tick, state }) => {
      ensureOpen();
      if (open.size > 0 || checkpoints.length >= CAUSAL_RECORDING_LIMITS.checkpoints || tick < timelineTick
        || (checkpoints.length > 0 && checkpoints.at(-1)!.tick >= tick)) throw new Error("checkpoint unavailable");
      timelineTick = tick;
      checkpoints.push(Object.freeze({
        tick,
        sim_time_ns: timeFor(tick, input.tick_duration_ns),
        event_sequence: events.length,
        state: recordedBytes(state),
      }));
    },
    closePort: (portId) => {
      ensureOpen();
      if (!declared.has(portId) || closed.has(portId) || open.size > 0) throw new Error("causal port close unavailable");
      closed.add(portId);
    },
    finalize: ({ tick, reason, state }) => {
      ensureOpen();
      const missingRequired = ports.some(({ port_id, minimum_exchanges }) =>
        exchangeCounts.get(port_id)! < minimum_exchanges);
      if (open.size > 0 || closed.size !== declared.size || missingRequired
        || !validId(reason) || tick < timelineTick) {
        throw new Error("causal recording incomplete");
      }
      finalized = true;
      const value = freeze({
        version: CAUSAL_RECORDING_VERSION,
        run_id: input.run_id,
        tick_duration_ns: input.tick_duration_ns,
        identity: { ...input.identity },
        ports,
        initial_checkpoint: {
          tick: 0,
          sim_time_ns: 0,
          event_sequence: 0,
          state: recordedBytes(input.initial_state),
        },
        events,
        checkpoints,
        terminal: {
          tick,
          sim_time_ns: timeFor(tick, input.tick_duration_ns),
          event_sequence: events.length,
          reason,
          state: recordedBytes(state),
        },
        closed_ports: [...closed].sort(),
      });
      return freeze({ ...value, recording_sha256: canonicalHash(value) });
    },
  };
  return Object.freeze(recorder);
};

export const assertCausalRecording = (input: CausalRecording): CausalRecording => {
  if (!exactKeys(input, [
    "version", "run_id", "tick_duration_ns", "identity", "ports",
    "initial_checkpoint", "events", "checkpoints", "terminal",
    "closed_ports", "recording_sha256",
  ])
    || !exactKeys(input.initial_checkpoint, [
      "tick", "sim_time_ns", "event_sequence", "state",
    ])
    || !Array.isArray(input.events)
    || input.events.some((event) => !exactKeys(event, [
      "sequence", "tick", "sim_time_ns", "issued_tick", "issued_sim_time_ns",
      "received_tick", "received_sim_time_ns", "port_id", "flow", "operation",
      "principal_id", "correlation_id", "causal_ids", "request", "outcome",
    ]) || (
      event.outcome.kind === "response"
        ? !exactKeys(event.outcome, ["kind", "status", "response", "chunks"])
        : event.outcome.kind === "error"
          ? !exactKeys(event.outcome, ["kind", "code", "error"])
          : event.outcome.kind === "timeout" || event.outcome.kind === "cancelled"
            ? !exactKeys(event.outcome, ["kind"])
            : true
    ))
    || !Array.isArray(input.checkpoints)
    || input.checkpoints.some((checkpoint) => !exactKeys(checkpoint, [
      "tick", "sim_time_ns", "event_sequence", "state",
    ]))
    || !exactKeys(input.terminal, [
      "tick", "sim_time_ns", "event_sequence", "reason", "state",
    ])) {
    throw new TypeError("invalid causal recording shape");
  }
  const { recording_sha256: declaredHash, ...unsigned } = input ?? ({} as CausalRecording);
  if (input?.version !== CAUSAL_RECORDING_VERSION || !validId(input.run_id)
    || !Number.isSafeInteger(input.tick_duration_ns) || input.tick_duration_ns <= 0
    || !validSha(declaredHash) || canonicalHash(unsigned) !== declaredHash) {
    throw new TypeError("invalid causal recording");
  }
  const rebuilt = createCausalRecorder({
    run_id: input.run_id,
    tick_duration_ns: input.tick_duration_ns,
    identity: input.identity,
    ports: input.ports,
    initial_state: decodeRecordedBytes(input.initial_checkpoint.state),
  });
  if (input.initial_checkpoint.tick !== 0 || input.initial_checkpoint.sim_time_ns !== 0
    || input.initial_checkpoint.event_sequence !== 0) throw new TypeError("invalid initial checkpoint");
  let eventIndex = 0;
  const replayEvent = (event: CausalBoundaryExchange): void => {
    if (event.sequence !== eventIndex + 1) throw new TypeError("invalid event sequence");
    const timing = { received_tick: event.received_tick, received_sim_time_ns: event.received_sim_time_ns };
    const reservation = rebuilt.begin({
      issued_tick: event.issued_tick,
      issued_sim_time_ns: event.issued_sim_time_ns,
      port_id: event.port_id,
      flow: event.flow,
      operation: event.operation,
      principal_id: event.principal_id,
      correlation_id: event.correlation_id,
      causal_ids: event.causal_ids,
      request: decodeRecordedBytes(event.request),
    });
    if (event.outcome.kind === "response") reservation.response({
      ...timing,
      status: event.outcome.status,
      response: decodeRecordedBytes(event.outcome.response),
      chunks: event.outcome.chunks.map(decodeRecordedBytes),
    });
    else if (event.outcome.kind === "error") reservation.error({ ...timing, code: event.outcome.code, error: decodeRecordedBytes(event.outcome.error) });
    else if (event.outcome.kind === "timeout") reservation.timeout(timing);
    else reservation.cancel(timing);
    eventIndex += 1;
  };
  for (const checkpoint of input.checkpoints) {
    if (!Number.isSafeInteger(checkpoint.event_sequence)
      || checkpoint.event_sequence < eventIndex
      || checkpoint.event_sequence > input.events.length) {
      throw new TypeError("invalid checkpoint event frontier");
    }
    while (eventIndex < checkpoint.event_sequence) replayEvent(input.events[eventIndex]!);
    rebuilt.checkpoint({ tick: checkpoint.tick, state: decodeRecordedBytes(checkpoint.state) });
  }
  while (eventIndex < input.events.length) replayEvent(input.events[eventIndex]!);
  for (const port of input.closed_ports) rebuilt.closePort(port);
  if (input.terminal.event_sequence !== input.events.length) {
    throw new TypeError("invalid terminal event frontier");
  }
  const verified = rebuilt.finalize({
    tick: input.terminal.tick,
    reason: input.terminal.reason,
    state: decodeRecordedBytes(input.terminal.state),
  });
  if (verified.recording_sha256 !== input.recording_sha256
    || canonicalCausalRecordingJson(verified) !== canonicalCausalRecordingJson(input)) throw new TypeError("noncanonical causal recording");
  return input;
};
