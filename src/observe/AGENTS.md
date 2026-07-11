# Simfile Observe

This folder implements `simfile observe <run-dir>` (Decision 21 / `contracts.md`'s
Slice B compose-and-observe pipeline). It is a **pure file-reading + reconciliation**
module: no Docker, no compile, no runtime auth — see the package charter in
`ecosystem/simfile/AGENTS.md`. It consumes a sealed run directory and never imports
Spawnfile internals; the only cross-repo dependency is the narrow shared package
`@noopolis/stele` (`ecosystem/stele`), which contracts.md permits explicitly.

## Files

- `manifest.ts` — the `simfile.run-manifest.v1` zod schema/type + `parseRunManifest`.
- `report.ts` — the `simfile.observe.v1` zod schema/type + `parseObserveReport`.
- `artifacts.ts` — `verifyManifestArtifacts`: sha256-checks every manifest-declared
  artifact against the file on disk. A mismatch is reported, never silently repaired.
- `causalStreams.ts` — `collectCausalStreams`: walks `<runDir>/raw/**/causal.jsonl`,
  tags each stream by its authority directory (`raw/<authority>/...`), and parses it
  with `@noopolis/stele`'s `parseCausalJsonl`.
- `memoryBanks.ts` — `collectMemoryBankCounts`: ledger-first (Slice B Piece 4b).
  Derives each bank's memory-write count from `memory.written` causal events
  (mneme's write-side envelope, reconciled alongside `memory.recalled`) when at
  least one is present, marking `memory_write_source: "ledger"` and deriving
  `writes_by_agent` from each event's `principal_id`. Falls back to the interim
  signal — mneme's own `raw/mneme/<bank>/events.jsonl` bank event log (NOT the
  causal envelope), or that bank's `memory.recalled` causal events if even that
  is absent — marking `memory_write_source: "events-fallback"` so a pre-4b run
  is visibly on the fallback, never silently. `recalls` is unaffected by which
  write source wins: it prefers `events.jsonl`'s own lines, falling back to
  causal `memory.recalled` events.
- `compute.ts` — pure functions building every `simfile.observe.v1` field from
  already-reconciled events: `participants` (from `principal_id`), `agent_turns`
  (ordered by the moltnet message seq that causally triggered each turn — never
  `recorded_at`), `chains` (from `@noopolis/stele`'s reconciliation states),
  `failures` (`turn.failed`/`wake.failed` events).
- `observe.ts` — `runObserve(runDir)` orchestrates the above and returns the
  report plus artifact-integrity/parse-error diagnostics; `writeObserveReport`
  writes `<runDir>/observe/report.json`.
- `index.ts` — barrel.

## Rules

- Never stitch. An incomplete causal chain (partial/unknown/stale/divergent) is
  flagged in `chains.incomplete`, never silently completed.
  `stitchInteractionChain`-style fixture repair belongs in Spawnfile's ledger and
  must never be imported here.
- `reconcile.ts`'s `reconcileEvents`/`traceCausesBackward` (from `@noopolis/stele`)
  stay pure; this folder's own I/O (manifest/artifact/stream reads) lives in
  dedicated files so `compute.ts` stays a pure, easily-tested function of
  already-loaded data.
- Keep files under 400 lines; split further before that limit.
