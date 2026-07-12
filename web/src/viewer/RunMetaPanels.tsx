import { useState } from "react";

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

export interface RunMeta {
  runId: string;
  verdict: RunMetaVerdict;
  provenance: {
    artifacts: RunMetaProvenanceArtifact[];
    entries: RunMetaProvenanceEntry[];
  };
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
