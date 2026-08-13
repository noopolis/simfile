export const CAUSAL_RECORDING_VERSION = "simfile.causal-recording.v1" as const;

export const CAUSAL_RECORDING_LIMITS = Object.freeze({
  bytes: 64 * 1024 * 1024,
  events: 1_000_000,
  ports: 1_024,
  checkpoints: 65_536,
});

export interface RecordedBytes {
  readonly encoding: "base64";
  readonly byte_length: number;
  readonly sha256: string;
  readonly data: string;
}

export interface CausalRecordingIdentity {
  readonly seed: string;
  readonly config_sha256: string;
  readonly artifact_sha256: string;
  readonly runtime_sha256: string;
  readonly reducer_sha256: string;
}

export interface CausalRecordingPort {
  readonly port_id: string;
  readonly owner: string;
  readonly minimum_exchanges: number;
}

export type CausalBoundaryOutcome =
  | Readonly<{ kind: "response"; status: number; response: RecordedBytes; chunks: readonly RecordedBytes[] }>
  | Readonly<{ kind: "error"; code: string; error: RecordedBytes }>
  | Readonly<{ kind: "timeout" }>
  | Readonly<{ kind: "cancelled" }>;

export interface CausalBoundaryExchange {
  readonly sequence: number;
  readonly tick: number;
  readonly sim_time_ns: number;
  readonly issued_tick: number;
  readonly issued_sim_time_ns: number;
  readonly received_tick: number;
  readonly received_sim_time_ns: number;
  readonly port_id: string;
  readonly flow: "into_world" | "out_of_world";
  readonly operation: string;
  readonly principal_id: string;
  readonly correlation_id: string;
  readonly causal_ids: readonly string[];
  readonly request: RecordedBytes;
  readonly outcome: CausalBoundaryOutcome;
}

export interface CausalRecordingCheckpoint {
  readonly tick: number;
  readonly sim_time_ns: number;
  /** Last event sequence already reflected by this checkpoint's state bytes. */
  readonly event_sequence: number;
  readonly state: RecordedBytes;
}

export interface CausalRecordingTerminal {
  readonly tick: number;
  readonly sim_time_ns: number;
  readonly event_sequence: number;
  readonly reason: string;
  readonly state: RecordedBytes;
}

export interface CausalRecording {
  readonly version: typeof CAUSAL_RECORDING_VERSION;
  readonly run_id: string;
  readonly tick_duration_ns: number;
  readonly identity: CausalRecordingIdentity;
  readonly ports: readonly CausalRecordingPort[];
  readonly initial_checkpoint: CausalRecordingCheckpoint;
  readonly events: readonly CausalBoundaryExchange[];
  readonly checkpoints: readonly CausalRecordingCheckpoint[];
  readonly terminal: CausalRecordingTerminal;
  readonly closed_ports: readonly string[];
  readonly recording_sha256: string;
}

export interface BoundaryExchangeInput extends Omit<CausalBoundaryExchange,
  "sequence" | "tick" | "sim_time_ns" | "received_tick" | "received_sim_time_ns" | "request" | "outcome"> {
  readonly request: Uint8Array;
}

export interface BoundaryCompletionTiming {
  readonly received_tick: number;
  readonly received_sim_time_ns: number;
}

export interface CausalBoundaryReservation {
  response(input: BoundaryCompletionTiming & { readonly status: number; readonly response: Uint8Array; readonly chunks?: readonly Uint8Array[] }): void;
  error(input: BoundaryCompletionTiming & { readonly code: string; readonly error: Uint8Array }): void;
  timeout(input: BoundaryCompletionTiming): void;
  cancel(input: BoundaryCompletionTiming): void;
}

export interface CausalRecorder {
  begin(input: BoundaryExchangeInput): CausalBoundaryReservation;
  checkpoint(input: { readonly tick: number; readonly state: Uint8Array }): void;
  closePort(portId: string): void;
  finalize(input: { readonly tick: number; readonly reason: string; readonly state: Uint8Array }): CausalRecording;
}
