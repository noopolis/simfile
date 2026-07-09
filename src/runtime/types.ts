import type { Provenance } from "../ledger/stable.js";

export interface RuntimeOptions {
  runId: string;
  seed: string;
  ticks: number;
  precision?: number;
}

export interface RuntimeTraceEvent {
  event_id: string;
  kind: string;
  sim_time: number;
  provenance: Provenance;
  actor: string;
  target: string;
  scope: string;
  payload: Record<string, unknown> | Array<unknown> | string | number | boolean | null;
}

export interface RuntimeVariableSample {
  phase: string | undefined;
  sim_time: number;
  tick: number;
  variables: Record<string, number>;
}

export interface RuntimeTrace {
  runId: string;
  seed: string;
  ticks: number;
  variables: Record<string, number>;
  events: RuntimeTraceEvent[];
  samples: RuntimeVariableSample[];
  diagnostics: string[];
}
