import { useState } from "react";

import type { SeedSpreadEntry, SpreadSummary } from "./spreadModel.js";
import { sampleAtTick, trajectoryUpToTick, type RunMetaVariableSample } from "./variableModel.js";

export type { RunMetaVariableSample } from "./variableModel.js";

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

/** One disclosed engine entry — `agent` present only for a per-agent (up-receipt) breakdown. */
export interface RunMetaEngineEntry {
  agent?: string;
  engine: string;
}

/**
 * The honesty-critical engine-provenance disclosure (`src/view/engineProvenance.ts`):
 * whether this run's dialogue is a deterministic scripted screenplay or came
 * from a real engine. Always present on `/api/run-meta` — an engine-less
 * manifest still yields `mode: "unknown"` rather than omitting the field, so
 * `EngineProvenanceBadge` always has something honest to render.
 */
export interface RunMetaEngineProvenance {
  mode: "scripted" | "real-engine" | "mixed" | "unknown";
  engines: RunMetaEngineEntry[];
  label: string;
}

export interface RunMeta {
  runId: string;
  verdict: RunMetaVerdict;
  provenance: {
    artifacts: RunMetaProvenanceArtifact[];
    entries: RunMetaProvenanceEntry[];
  };
  engineProvenance: RunMetaEngineProvenance;
  participants: string[];
  /** Increment 3: undefined for a run with no `manifest.seed_declaration` (graceful absence, never a fabricated empty spread). */
  seedSpread?: SeedSpreadEntry[];
  spreadSummary?: SpreadSummary;
  /** Increment 3: undefined unless the run has a non-empty `world/telemetry.json` variable sample set. */
  variableSamples?: RunMetaVariableSample[];
}

/**
 * The unmissable topbar badge that disclosed which run this is: a canned,
 * deterministic screenplay (`"scripted"`) or a real engine driving live
 * agents (`"real-engine"`) — plus the honest `"mixed"`/`"unknown"` states
 * when the run's own provenance data does not cleanly resolve to one or the
 * other. This is the fix for a real confusion that already happened (a
 * scripted demo mistaken for live agents), so it renders `meta.engineProvenance.label`
 * verbatim rather than a shortened/softened version — the label itself is
 * already worded to be unambiguous ("authored screenplay, not emergent
 * dialogue" for scripted; the engine name for real).
 */
export function EngineProvenanceBadge({ provenance }: { provenance: RunMetaEngineProvenance }) {
  return (
    <span
      aria-label="Engine provenance disclosure"
      className={`engine-badge engine-badge-${provenance.mode}`}
      title={provenance.engines.map((entry) => (entry.agent ? `${entry.agent}: ${entry.engine}` : entry.engine)).join(", ")}
    >
      {provenance.label}
    </span>
  );
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
 * A minimal, dependency-free sparkline: a single 2px polyline (the app's
 * `--cyan` accent, matching the spread readout's own use of that color for
 * "a live-ish signal") plus a small dot marking the current (rightmost, "as
 * of cursor") value — the dataviz skill's single-series guidance: no axis,
 * no legend (the numeric value already renders as text beside it), normalized
 * to the trajectory's own min/max so a flat run still reads as a flat line
 * rather than dividing by zero.
 */
export function VariableSparkline({ values }: { values: readonly number[] }) {
  const width = 56;
  const height = 16;
  const pad = 2;
  if (values.length < 2) return null;

  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const stepX = (width - pad * 2) / (values.length - 1);
  const points = values.map((value, index) => {
    const x = pad + index * stepX;
    const y = height - pad - ((value - min) / span) * (height - pad * 2);
    return [x, y] as const;
  });
  const last = points[points.length - 1]!;

  return (
    <svg
      aria-hidden="true"
      className="variable-sparkline"
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      width={width}
    >
      <polyline
        fill="none"
        points={points.map(([x, y]) => `${x},${y}`).join(" ")}
        stroke="var(--cyan)"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.5}
      />
      <circle cx={last[0]} cy={last[1]} fill="var(--accent-hi)" r={1.6} />
    </svg>
  );
}

/**
 * Variable gauge rail (increment 4): reads `world/telemetry.json`'s
 * per-tick samples (`variableSamples`, passed through unmodified from
 * `/api/run-meta`) at `tick` — the world clock's own tick "as of" the
 * scrub cursor (`variableModel.ts`'s `tickAtCursor`, computed by the
 * caller since this component stays free of a `RunTimeline`/store
 * dependency, matching `SpreadReadout`'s existing plain-props shape).
 * Renders nothing when the run has no non-empty variable samples at all
 * (`office-sim-golden`/`office-secret-v0-golden`) or the cursor is before
 * the run's first `clock.sync` (`tick` is `undefined`) — never a fabricated
 * gauge. Each variable is a clickable chip (`onSelectVariable`) that opens
 * its own storyline portal, the same `focusAndOpenPortal` mechanism every
 * other element kind uses — wired by the caller, not here, so this
 * component never imports the timeline store directly.
 */
export function VariableGaugeRail({
  samples,
  tick,
  onSelectVariable,
}: {
  samples: RunMetaVariableSample[] | undefined;
  tick: number | undefined;
  onSelectVariable: (variableId: string) => void;
}) {
  const asOf = sampleAtTick(samples, tick);
  const variableIds = asOf ? Object.keys(asOf.variables) : [];
  if (!asOf || variableIds.length === 0) return null;

  return (
    <div className="variable-gauge-rail" aria-label="World variables">
      {variableIds.map((id) => (
        <button
          aria-label={`Open ${id} storyline`}
          className="variable-gauge"
          key={id}
          onClick={() => onSelectVariable(id)}
          type="button"
        >
          <span className="variable-gauge-label">{id}</span>
          <span className="variable-gauge-value">{asOf.variables[id]!.toFixed(2)}</span>
          <VariableSparkline values={trajectoryUpToTick(samples, id, tick)} />
        </button>
      ))}
    </div>
  );
}
