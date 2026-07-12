import { useState } from "react";

import type { SeedSpreadEntry, SpreadSummary } from "./spreadModel.js";

/**
 * Verdict + provenance, ported into the React run-replay shell so it reaches
 * parity with the retired bespoke `runPage.ts` page (increment 2 rule 3).
 * The shapes below mirror `src/view/runViewModelTypes.ts`'s `RunVerdict` /
 * `RunViewModel["provenance"]` — a structural duplicate of the `/api/run-meta`
 * JSON contract, the same web/src-never-imports-src/ boundary every other
 * store type in this app already follows (see `../store/timeline.ts`'s note).
 *
 * `computeVerdict`/`computeProvenance` themselves are NOT reimplemented here:
 * this file only renders the JSON they already produce server-side.
 *
 * Increment 3 adds `SpreadReadout` (reach/latency/first-appearance, sourced
 * from `spreadSummary` — never recomputed) and `VariableGaugeRail` (a seam:
 * renders only when `variableSamples` is a non-empty, non-fabricated set —
 * `office-secret-v0-golden` drives no variable, so it renders nothing there).
 */
export interface RunMetaVerdict {
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

export interface RunMetaProvenanceArtifact {
  path: string;
  sha256: string;
  ok: boolean;
}

export interface RunMetaProvenanceEntry {
  key: string;
  value: string;
}

/** One `world/telemetry.json` sample row — mirrors `src/view/runViewModelTypes.ts`'s `RunTelemetrySample`. */
export interface RunMetaVariableSample {
  tick: number;
  simTime: number;
  phase?: string;
  variables: Record<string, number>;
}

export interface RunMeta {
  runId: string;
  verdict: RunMetaVerdict;
  provenance: {
    artifacts: RunMetaProvenanceArtifact[];
    entries: RunMetaProvenanceEntry[];
  };
  participants: string[];
  /** Increment 3: undefined for a run with no `manifest.seed_declaration` (graceful absence, never a fabricated empty spread). */
  seedSpread?: SeedSpreadEntry[];
  spreadSummary?: SpreadSummary;
  /** Increment 3: undefined unless the run has a non-empty `world/telemetry.json` variable sample set. */
  variableSamples?: RunMetaVariableSample[];
}

/** The compact verdict strip in the topbar: participants/turns/chains/memory/failures/artifacts at a glance. */
export function VerdictStrip({ meta, onOpenProvenance }: { meta: RunMeta; onOpenProvenance: () => void }) {
  const { verdict } = meta;
  return (
    <button
      aria-label="Open provenance panel"
      className={`verdict-strip ${verdict.healthy ? "healthy" : "unhealthy"}`}
      onClick={onOpenProvenance}
      type="button"
    >
      <span className="verdict-dot" aria-hidden="true">{verdict.healthy ? "●" : "▲"}</span>
      <span>{verdict.turnCount} turns</span>
      <span>{verdict.chainsComplete} chains complete{verdict.chainsIncomplete > 0 ? ` · ${verdict.chainsIncomplete} incomplete` : ""}</span>
      <span>{verdict.memoryEvents} memory events · {verdict.memoryRecalls} recalls</span>
      {verdict.failures > 0 ? <span className="verdict-failures">{verdict.failures} failures</span> : null}
      <span>{verdict.artifactsVerified}/{verdict.artifactsTotal} artifacts verified</span>
    </button>
  );
}

/** The provenance drawer: per-artifact sha256 + ok, and the reconciliation entries (participants, turn sequence, chains, contract). */
export function ProvenancePanel({ meta, onClose }: { meta: RunMeta; onClose: () => void }) {
  return (
    <aside className="provenance-panel" aria-label="Run provenance">
      <div className="provenance-header">
        <span className="provenance-title">provenance · {meta.runId}</span>
        <button aria-label="Close provenance panel" onClick={onClose} type="button">×</button>
      </div>
      <div className="provenance-body">
        <section>
          <h3>artifacts · sha-256 verified</h3>
          <ul className="provenance-artifacts">
            {meta.provenance.artifacts.map((artifact) => (
              <li className={artifact.ok ? "ok" : "fail"} key={artifact.path}>
                <span className="artifact-path">{artifact.path}</span>
                <span className="artifact-sha">{artifact.sha256.slice(0, 12)}…</span>
                <span className="artifact-status">{artifact.ok ? "verified" : "MISMATCH"}</span>
              </li>
            ))}
          </ul>
        </section>
        <section>
          <h3>reconciliation</h3>
          <dl className="provenance-entries">
            {meta.provenance.entries.map((entry) => (
              <div key={entry.key}>
                <dt>{entry.key}</dt>
                <dd>{entry.value}</dd>
              </div>
            ))}
          </dl>
        </section>
      </div>
    </aside>
  );
}

/** Owns the drawer's open/closed state so `RunReplayShell` only wires the fetch + one boolean-toggle button. */
export function useProvenancePanel(): { open: boolean; toggle: () => void; close: () => void } {
  const [open, setOpen] = useState(false);
  return { open, toggle: () => setOpen((value) => !value), close: () => setOpen(false) };
}

/**
 * The meme-spread readout (increment 3): reach/total, latency in ticks, and
 * the first non-seed agent to carry it — all read straight off
 * `spreadSummary` (`src/observe/seedSpread.ts`'s `computeSummary`), never
 * recomputed here. Renders nothing when `spreadSummary` is absent (a run
 * with no `manifest.seed_declaration`), which is the normal case for most
 * runs, not an error state.
 */
export function SpreadReadout({
  summary,
  seedSpread,
  participants,
}: {
  summary: SpreadSummary;
  seedSpread: SeedSpreadEntry[];
  participants: string[];
}) {
  const first = summary.first_appearance[0];
  const seedAgent = seedSpread.find((entry) => entry.channel === "doc-seeded")?.agent;
  const eligible = seedAgent ? participants.filter((participant) => participant !== seedAgent).length : participants.length;
  return (
    <span className="spread-readout" aria-label="Seeded meme spread">
      <span className="spread-dot" aria-hidden="true">🧬</span>
      <span>spread {summary.reach}/{eligible}</span>
      {summary.latency !== undefined ? <span>· {summary.latency} tick{summary.latency === 1 ? "" : "s"}</span> : null}
      {first ? <span>· first: {first.agent}</span> : null}
    </span>
  );
}

/**
 * Variable gauge seam (increment 3): `office-secret-v0` drives no
 * variable, so `variableSamples` is undefined there and this renders
 * nothing — do not fake a gauge. Wired for the day a run's
 * `world/telemetry.json` actually carries variable samples: shows each
 * variable's latest value from the last sample.
 */
export function VariableGaugeRail({ samples }: { samples: RunMetaVariableSample[] | undefined }) {
  const latest = samples?.[samples.length - 1];
  const variableIds = latest ? Object.keys(latest.variables) : [];
  if (!latest || variableIds.length === 0) return null;

  return (
    <div className="variable-gauge-rail" aria-label="World variables">
      {variableIds.map((id) => (
        <span className="variable-gauge" key={id}>
          <span className="variable-gauge-label">{id}</span>
          <span className="variable-gauge-value">{latest.variables[id]!.toFixed(2)}</span>
        </span>
      ))}
    </div>
  );
}
