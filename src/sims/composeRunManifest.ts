import { createHash } from "node:crypto";

import {
  RUN_MANIFEST_VERSION,
  type RunManifestArtifactEntry,
  type SeedDeclaration,
  type SimfileRunManifest
} from "../observe/manifest.js";
import { OBSERVE_REPORT_VERSION } from "../observe/report.js";

/** The one fixed `contract_versions` map every composed run stamps —
 * mirrors the golden fixture's manifest.json exactly (same three keys, same
 * literal `causal-event.v1` value) so a composed run and the golden capture
 * are structurally comparable. */
const CONTRACT_VERSIONS: Record<string, string> = {
  "causal-event.v1": "noopolis.causal-event.v1",
  "simfile.observe.v1": OBSERVE_REPORT_VERSION,
  "simfile.run-manifest.v1": RUN_MANIFEST_VERSION
};

export const sha256HexOfBuffer = (buffer: Buffer): string => createHash("sha256").update(buffer).digest("hex");

export interface ComposeRunManifestWorld {
  network_id: string;
  room_id: string;
  members: string[];
}

export interface ComposeRunManifestInput {
  runId: string;
  /** ISO 8601 timestamp, passed in rather than generated here so the
   * composer stays a pure function of its arguments (deterministic, no
   * hidden `Date.now()` read). */
  createdAt: string;
  /** `spawnfile.up-receipt.v1`'s fingerprint, when available. */
  fingerprint?: string | null;
  /** Disclosed engine kind (Piece 5) — this composed office-sim always runs
   * every agent on the `scripted` engine, so callers pass a single string
   * (e.g. derived by collapsing the up-receipt's `engines[]` to its one
   * distinct value). */
  engine: string;
  world: ComposeRunManifestWorld;
  /** `{path, sha256}` entries folded straight from `spawnfile artifacts
   * export --json`'s `index.files` (per that contract's own docstring: "so
   * a future `simfile.run-manifest.v1` can fold `files` straight into its
   * own `artifacts` array ... without re-deriving anything"). */
  exportedArtifacts: readonly RunManifestArtifactEntry[];
  /** Artifacts this driver itself writes after export (e.g.
   * `raw/moltnet/transcript.json`), each already hashed by the caller. */
  extraArtifacts?: readonly RunManifestArtifactEntry[];
  /** Decision-13 ground truth for a doc-seeded memetics secret (memetics
   * increment (a) — the world-driven driver). Omitted for a plain office-sim
   * run, which has no seeded secret. */
  seedDeclaration?: SeedDeclaration;
}

/**
 * Writes `simfile.run-manifest.v1` for a composed run (Piece 5 step 3's
 * "writes `manifest.json` LAST" driver step). Pure and deterministic given
 * its inputs: no filesystem, no clock read, no network — artifact hashing
 * happens before this is called, and `createdAt` is threaded in rather than
 * generated here. Artifacts are sorted by path for a stable byte-identical
 * manifest across two structurally-identical runs (the parity gate's
 * determinism check).
 */
export const composeRunManifest = (input: ComposeRunManifestInput): SimfileRunManifest => {
  const artifacts = [...input.exportedArtifacts, ...(input.extraArtifacts ?? [])]
    .map((artifact) => ({ path: artifact.path, sha256: artifact.sha256 }))
    .sort((left, right) => left.path.localeCompare(right.path));

  return {
    version: RUN_MANIFEST_VERSION,
    run_id: input.runId,
    created_at: input.createdAt,
    contract_versions: CONTRACT_VERSIONS,
    ...(input.fingerprint ? { spawnfile: { fingerprint: input.fingerprint } } : {}),
    artifacts,
    engine: input.engine,
    ...(input.seedDeclaration ? { seed_declaration: input.seedDeclaration } : {}),
    // `SimfileRunManifest.world` is a free-form `Record<string, unknown>`
    // (genre-neutral schema); this composer's own `ComposeRunManifestWorld`
    // is the concrete shape it always writes.
    world: input.world as unknown as Record<string, unknown>
  };
};
