import type { CausalEvent } from "@noopolis/stele";

import type { EngineProvenance } from "./engineProvenance.js";
import type { SeedSpreadEntry, SpreadSummary } from "../observe/report.js";

/**
 * `RunViewModel` — the data-driven model the run-reader page renders
 * (`docs/VIEW_DESIGN.md` rule 3: every rendered element traces to a record id).
 * Built once per `simfile view <run-dir>` invocation by
 * `buildRunViewModel` (`runViewModel.ts`) from a sealed compose-and-observe
 * run directory: the reconciled `simfile.observe.v1` report, the raw
 * moltnet transcript, and the raw per-bank mneme event logs. Nothing here
 * is invented; fields that cannot be derived from a real record are simply
 * omitted (`trace`, `recallEventIds` on non-agent messages).
 */
export interface RunVerdict {
  healthy: boolean;
  turnCount: number;
  chainsComplete: number;
  chainsIncomplete: number;
  memoryEvents: number;
  memoryRecalls: number;
  artifactsVerified: number;
  artifactsTotal: number;
  failures: number;
}

/** One hop the causal trace names, each a real `event_id` from a causal stream. */
export interface RunThreadTrace {
  /** The moltnet message event_id that triggered this turn. */
  inEventId: string;
  /** `daimon` `control.wake.accepted` event_id for this turn, when reconciled. */
  wakeEventId?: string;
  turnInputEventId: string;
  turnOutputEventId?: string;
  /** `turn.input.submitted`'s own `cause_event_ids`, verbatim. */
  turnInputCauses: string[];
  /** The subset of `turnInputCauses` prefixed `mneme:` — memories that fed this turn. */
  recalledMemoryEventIds: string[];
  /** This turn's mneme bank writes (claimed/observed/recalled), in file order. */
  memoryWrites: RunMindRow[];
}

export interface RunThreadMessage {
  messageId: string;
  /** `null` for a human/operator message — it has no daimon turn. */
  agentId: string | null;
  fromName: string;
  /** 1-based ordinal among agent-authored messages; `null` for the seed. */
  turn: number | null;
  role: string;
  createdAt: string;
  text: string;
  /** Agent ids `@mentioned` in this message's text. */
  mentions: string[];
  trace?: RunThreadTrace;
}

export type RunMindStratum = "claimed" | "observed" | "recalled";

export interface RunMindRow {
  stratum: RunMindStratum;
  text: string;
  sourceId: string;
}

export interface RunMindPortal {
  agentId: string;
  eventCount: number;
  rows: RunMindRow[];
}

export interface RunProvenanceArtifact {
  path: string;
  sha256: string;
  ok: boolean;
}

export interface RunProvenanceEntry {
  key: string;
  value: string;
}

export interface RunViewModel {
  version: "simfile.run-view-model.v1";
  runId: string;
  createdAt: string;
  engine?: string;
  /**
   * The honesty-critical disclosure (docs/VIEW_DESIGN.md / the run-replay badge):
   * whether this run's dialogue came from a deterministic scripted
   * screenplay or a real engine, derived by `engineProvenance.ts` from
   * `spawnfile/up-receipt.json`'s per-agent `engines[]` when present, else
   * this same `engine` field collapsed to one entry. Never absent — an
   * engine-less manifest still yields `{mode: "unknown", ...}` rather than
   * omitting the field, so the viewer always has something to badge.
   */
  engineProvenance: EngineProvenance;
  world?: { networkId?: string; roomId?: string; members?: string[] };
  participants: string[];
  verdict: RunVerdict;
  thread: RunThreadMessage[];
  minds: RunMindPortal[];
  provenance: {
    artifacts: RunProvenanceArtifact[];
    entries: RunProvenanceEntry[];
  };
  /**
   * Increment 3: `runObserve`'s already-computed `seed_spread`/
   * `spread_summary` (`../observe/seedSpread.ts`), passed through verbatim
   * — never recomputed here. Both are DEFINED-BUT-OPTIONAL
   * (`../observe/report.ts`): a run with no `manifest.seed_declaration`
   * (e.g. `office-sim-golden`) simply omits them, and the viewer renders no
   * spread UI at all rather than fake reach/latency numbers.
   */
  seedSpread?: SeedSpreadEntry[];
  spreadSummary?: SpreadSummary;
  /**
   * Increment 3: `world/telemetry.json`'s per-tick variable samples, when
   * the run has any (`readWorldTelemetry` in `runRawArtifacts.ts`).
   * Omitted — never a fabricated empty gauge — when the run has no
   * telemetry file, or every sample's `variables` map is empty (e.g.
   * `office-secret-v0-golden`, which drives no variable).
   */
  variableSamples?: RunTelemetrySample[];
}

/** One `world/telemetry.json` sample row (`simfile.telemetry.v1`, `src/runtime/run-record.ts`'s `TelemetryArtifact`). */
export interface RunTelemetrySample {
  tick: number;
  simTime: number;
  phase?: string;
  variables: Record<string, number>;
}

/** The raw `raw/moltnet/transcript.json` shape this package writes and reads. */
export interface RawTranscriptMessage {
  id: string;
  from: { type: string; id: string; name: string };
  /**
   * `data` is the `simfile_event_id`/`simfile_event_kind`/`simfile_rule_id`
   * breadcrumb `src/moltnet/world-participant.ts`'s `metadataFromEvent`
   * attaches to a message that originated from a world action
   * (`world.message`/`world.dm`/`wake.recommended`) — absent on a genuine
   * agent-authored message.
   */
  parts: { kind: string; text?: string; data?: Record<string, unknown> }[];
  mentions?: string[];
  created_at: string;
}

export interface RawTranscript {
  seedMessageText?: string;
  transcript: RawTranscriptMessage[];
}

/** One line of a mneme bank's `events.jsonl` (the human-readable memory log). */
export interface RawMnemeEvent {
  id: string;
  type: string;
  createdAt: string;
  principal: { agentId: string };
  content: { kind: string; text: string };
  /** This bank log's own causal predecessors (distinct id space from `causal.jsonl`'s `event_id`s). */
  parentEventIds?: string[];
  /** Per-principal sequence number within this bank's `events.jsonl`. */
  seq?: number;
}

export interface RunViewModelSource {
  events: readonly CausalEvent[];
  mnemeEventsByBank: ReadonlyMap<string, readonly RawMnemeEvent[]>;
  transcript: RawTranscript;
}
