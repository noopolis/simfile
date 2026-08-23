# Simfile Observe

This folder implements `simfile observe <run-dir>` (Decision 21 / `contracts.md`'s
Slice B compose-and-observe pipeline). It is a **pure file-reading + reconciliation**
module: no Docker, no compile, no runtime auth — see the package charter in
the repository `AGENTS.md`. It consumes a sealed run directory and never imports
Spawnfile internals; the only cross-repo dependency is the narrow shared package
`@noopolis/stele`, which the contracts permit explicitly.

## Files

- `manifest.ts` — the `simfile.run-manifest.v1` zod schema/type + `parseRunManifest`.
- `report.ts` — the `simfile.observe.v1` zod schema/type + `parseObserveReport`.
- `artifacts.ts` — `verifyManifestArtifacts`: sha256-checks every manifest-declared
  artifact against the file on disk. A mismatch is reported, never silently repaired.
- `rawFiles.ts` — the shared raw-artifact locator. It preserves the historical
  top-level `raw/**` tree and admits exact nested raw artifacts only when the
  sealed manifest names them (for example a composed `organization/raw/**`
  export), exposing an honest run-relative path plus its `raw/`-relative
  authority path.
- `causalStreams.ts` — `collectCausalStreams`: reads every raw locator result
  ending in `causal.jsonl`, tags it by the authority directly below its own
  `raw/` namespace, and parses it with `@noopolis/stele`'s
  `parseCausalJsonl`.
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
  `failures` (`turn.failed`/`wake.failed` events, plus any `seedSpread.ts`
  exclusion). `buildObserveReport` takes an optional `seedSpread` input
  (memetics increment (b)) and folds it into `seed_spread`/`spread_summary`
  when present — omitted entirely for a manifest without `seed_declaration`;
  it also folds a recorded manifest world-grant marker into `world_grants`.
- `worldGrants.ts` — validates and folds the manifest's optional
  `world.world_grants` marker into observer evidence while preserving absence
  as distinct from `none-declared`.
- `seedSpreadArtifacts.ts` — I/O-only reads `seedSpread.ts`'s re-derivation
  needs beyond `causalStreams.ts`/`memoryBanks.ts`: `readSpreadTranscriptMessages`
  (every `transcript.json` under `raw/moltnet/**`, flattened to `{id, fromId,
  text}`), `readSpreadMnemeEventsByBank` (every bank's `events.jsonl` parsed to
  `{id, type, agentId, text}` — a malformed line is skipped, never a crash),
  `readTickByIngestedMessageId` (`world/ingested-messages.jsonl`'s `message_id
  -> tick` join; empty map for a non-world-driven run).
- `seedSpread.ts` — memetics increment (b)'s pure `computeSeedSpread`: re-derives
  `seed_spread` from sealed artifacts + `manifest.seed_declaration`, applying
  the manifest-pinned matcher from `spreadMatcher.ts` to transcript messages
  (`uttered`), mneme bank content
  joined to any `memory.written` ledger event (`registered`, ledger-first —
  same precedence as `memoryBanks.ts`), and `memory.recalled` causal events'
  joined content (`recalled`) — plus exactly one `doc-seeded` entry taken
  verbatim from the manifest. Never scans `turn.input.submitted` payloads
  (exposure is not expression); excludes any hit whose actor is `world` or
  `operator:<agent>` into `excluded` (an instrument/containment flag, folded
  into `failures` by `compute.ts`, never counted as spread). Also computes
  `spread_summary` (`reach`, `latency`, `first_appearance`) excluding the seed
  agent's own appearances. `diffSeedSpreadAgainstLiveMarkerSeen` is a
  diagnostic-only self-check against the live world loop's own `marker.seen`
  events (`spreadSelfCheck` on `ObserveResult`, never fed into the report
  itself — live polling order is not causal order).
- `spreadMatcher.ts` — pure policy parser and matcher for seed spread. `exact`
  reuses `../ledger/markers.ts`'s word-boundary matching; `edit-distance` uses
  local Levenshtein scoring; model-backed policies fail loudly as unsupported.
- `observe.ts` — `runObserve(runDir)` orchestrates the above and returns the
  report plus artifact-integrity/parse-error/spread-self-check diagnostics;
  `writeObserveReport` writes `<runDir>/observe/report.json`.
- `summaryLines.ts` — pure rendering of the plain-text observe summary,
  including the three world-grant output forms.
- `observeCommand.ts` — the CLI adapter for `simfile observe`; owns its
  argument parsing, warnings, output selection, and exit code.
- `index.ts` — barrel.

## Rules

- Never stitch. An incomplete causal chain (partial/unknown/stale/divergent) is
  flagged in `chains.incomplete`, never silently completed.
  `stitchInteractionChain`-style fixture repair belongs in Spawnfile's ledger and
  must never be imported here.
- `reconcile.ts`'s `reconcileEvents`/`traceCausesBackward` (from `@noopolis/stele`)
  stay pure; this folder's own I/O (manifest/artifact/stream reads) lives in
  dedicated files so `compute.ts`/`seedSpread.ts` stay pure, easily-tested
  functions of already-loaded data.
- Seed-spread re-derivation never trusts the live world loop's own
  `marker.seen` events as evidence (poll order ≠ causal order) — it is only
  ever a self-check diagnostic, never a source for `seed_spread` itself.
- Keep files under 400 lines; split further before that limit.
