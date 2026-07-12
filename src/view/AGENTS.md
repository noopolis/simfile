# Simfile Viewer Runtime

This folder contains the `simfile view` implementation: CLI argument parsing,
the static/JSON/SSE server for the world (GlyphCSS) replay and live modes, and
an additive **run-replay mode** for compose-and-observe run directories
(`manifest.json` @ `simfile.run-manifest.v1` + `raw/moltnet/transcript.json`
— the shape in `fixtures/observe/office-sim-golden/`, and a real engine run,
e.g. `runs/real-grok-composed/`). Run-replay mode serves the same React
shell as world/live mode (`web/src/viewer/RunReplayShell.tsx`), fed by
`/api/timeline` and a `viewer.trace.v1`-shaped `/api/world` adapter, so the
existing time-scrubbable map/portal machinery renders a real run instead of
a bespoke page.

## Structure

- `index.ts` parses `simfile view` CLI arguments and launches the server.
- `server.ts` hosts static files from `../web` and provides read-only JSON/SSE
  endpoints for the world viewer; at startup it calls `loadRunReplay` to
  detect run-replay mode (`isObserveRunDir`) and, when detected, additionally
  serves `/api/timeline`, an adapted `/api/world`, and `/api/run-meta`
  (`{ runId, verdict, provenance, engineProvenance, participants }`, reusing
  `computeVerdict`/`computeProvenance` unchanged, plus increment 3's
  `seedSpread`/`spreadSummary`/`variableSamples` — each omitted, never
  faked, when the run has none) — `/` still falls through to the same React
  static assets as world/live mode, and `/api/state.mode` reports
  `"run-replay"`. `engineProvenance` (the honesty-gap fix) is NEVER omitted,
  unlike the seed/variable fields above: an engine-less manifest still
  yields `{mode: "unknown", ...}` so the viewer always has an honest badge
  to render. `/api/events` (the live SSE tick) is not served in this mode.
  `/api/run-view-model.json` is retired (increment 2): it 404s like any
  other unknown path.
- `engineProvenance.ts` — the honesty-critical disclosure logic: whether a
  run's dialogue came from a deterministic scripted screenplay or a real
  engine (the confusion this closes: a canned demo mistaken for live
  agents). `classifyEngineName` maps one engine string to `"scripted"`
  (`fake-*`/exactly `"scripted"`), `"real-engine"` (a recognized model name
  — `grok`/`codex`/`agy`/`claude`, matched as a whole segment so
  `claude-sonnet-4.5` still matches but `agyeman` does not), or `"unknown"`
  — absence or an unrecognized string NEVER collapses to real.
  `computeEngineProvenance` folds a list of `{agent?, engine}` entries into
  one `EngineProvenance` (`mode`/`engines`/`label`): all-agree -> that
  classification; disagree -> `"mixed"` (itself a disclosure, listing each
  agent's own engine in the label). `runViewModel.ts` feeds it either
  `spawnfile/up-receipt.json`'s per-agent `engines[]` (`readUpReceiptEngines`
  in `runRawArtifacts.ts`, when a composed run-dir has one) or the
  manifest's single `engine` field collapsed to one entry.
- `runDetect.ts` — `isObserveRunDir`: the shape check that selects
  run-replay mode (never touched when `--state` is passed — that always
  means the world live mode).
- `runRawArtifacts.ts` — shared, I/O-only reads of the raw run-directory
  artifacts `runViewModel.ts` and `runTimeline.ts` need: `readTranscript`
  (normalizes both `raw/moltnet/transcript.json` shapes — the golden
  fixture's `{seedMessageText, transcript}` and a real composed run's export
  `{conversations:[{messages}]}` — into one internal message list),
  `readMnemeEventsByBank`, and (increment 3) `readWorldTelemetry`/
  `hasVariableSamples` — reads `world/telemetry.json` when present and
  gates whether its variable samples are real (never a fabricated empty
  gauge when every sample's `variables` map is empty, as in
  `office-secret-v0-golden`; a real ramp lives in
  `fixtures/observe/office-pressure-v0-golden/`, increment 4) — and
  `readUpReceiptEngines`, the optional finer-grained read for
  `engineProvenance.ts`: `spawnfile/up-receipt.json`'s `engines[]` when a
  composed run-dir carries one (loosely parsed, `undefined` on any
  missing/malformed file rather than throwing — `runViewModel.ts` falls back
  to the manifest's own single `engine` field).
- `runTimelineTypes.ts` / `runTimelineRefs.ts` / `runTimelineRecords.ts` /
  `runTimeline.ts` — `buildRunTimeline(runDir)` merges every `causal.jsonl`
  stream (`../observe/causalStreams.ts`) and every mneme bank's
  `events.jsonl` row into one deterministic `RunTimeline`: sorted by
  `recorded_at` with a `(authority, stream_id, seq, event_id)` tie-break,
  then a causal-repair pass (no `TimelineEvent` may precede any of its own
  `causes`), then a dense scrub key `t` assigned in final order. This is
  the only file that assigns `t` — everything downstream treats it as
  ground truth. `runTimelineRefs.ts` holds the small `ElementRef`/string
  helpers (`agentRef`/`roomRef`/`bankRef`/`stringField`/...) both
  `runTimeline.ts` and `runTimelineRecords.ts` need; `runTimelineRecords.ts`
  holds the per-authority raw-record builders (`buildCausalRecord`'s
  moltnet/daimon/mneme/**world** branches — `buildWorldRecord` is
  increment 3's addition: `clock.sync` → `viewClass: "clock"` anchored on
  a dedicated `clock:global` ref, `marker.seen` → `viewClass: "marker"`
  attributed to the room + the real agent joined by `source_event_id`,
  `world.message`/`world.dm` → `viewClass: "message"` with `text` from the
  event's own `content`, `wake.recommended` → `viewClass: "wake"`, shared
  with daimon's `control.wake.accepted`). `buildMoltnetRecord` also sets
  `worldEventId` on a message that echoes a world action (the
  `simfile_event_id` breadcrumb in the transcript message's `parts[].data`)
  — the dedup join `web/src/store/timeline.ts`'s `echoedWorldEventIds` and
  `web/src/viewer/ReplayPanes.tsx`'s `ChatPane` use to suppress a
  `world.message`'s moltnet twin and badge the survivor "world". Split
  three ways so no one file passes 400 lines (`AGENTS.md`).
  **Variable storyline (increment 4):** every world-authority branch
  additionally folds `variable:<id>` refs (`runTimelineRefs.ts`'s
  `variableRef`) into its `subjects`, read from the event's own
  `payload.variables` (`variableRefsFromPayload`) — the array
  `src/runtime/step-tick.ts`/`rule-actions.ts` stamp onto a `rule.fired`
  event and every world-effect event it emits, whenever that rule's `when:`
  condition references a variable. This is how a `rule.fired`/`world.message`
  ends up on `variable:filing_pressure`'s own storyline
  (`eventsForElement(timeline, "variable:filing_pressure")`) without this
  file re-deriving anything from the Simfile schema itself — it only reads a
  field the runtime already put on the event. `world.act` is attributed
  directly to the fed variable it wrote (`payload.target` IS the variable id
  for that one event kind). `buildRunTimeline` also enumerates a `kind:
  "variable"` element per distinct `variable:<id>` subject actually present
  in the run's own records (never a separate schema/telemetry read) —
  absent entirely for a run with no world stream (`office-sim-golden`) or
  one whose rules never reference a variable (`office-secret-v0-golden`).
  **Multi-network attribution:** `buildMoltnetRecord` names each
  `message.accepted`'s room from its OWN network stream_id + `target.room_id`
  (`roomForMoltnetMessage`), never the run's single primary room — so an
  inner-council message in a recursive-psyche run stays under
  `room:<inner_net>:<room>` instead of collapsing onto the floor room. Paired
  with codex's daimon per-causing-message room fix (`buildDaimonRecord`), the
  representative's two turns land under the DIFFERENT rooms that woke them
  (`room:psyche-floor:commons` inbound, `room:<inner>:<council>` after the
  council concludes). `buildRunTimeline` parses `manifest.world` as either the
  single `{network_id, room_id, members}` shape (office-sim) or the
  multi-network `{rooms: [...]}` shape (the jungian psyche), and enumerates a
  `kind: "team"` element per derived membrane.
- `membranes.ts` — `deriveMembranes(report)` / `readRunMembranes(runDir)`:
  derives `RunTimeline.membranes` (the "descend into a mind" structure) from
  the run's `spawnfile-report.json` compile report (loose local parse — never a
  Spawnfile TS import). A membrane is an interior self-team: a team owning its
  own Moltnet network, represented on a parent floor by one of its members. The
  definitive interior-vs-parent signal is the compile report's
  `nodes[].active_environments.moltnet[network][room].member_slot` — in the
  parent room a representative's slot is the TEAM it stands in for (not its own
  id), in its own council room it is its own id — which no `server_plans`-only
  read can tell apart. Interior rooms + members come from the team-owned
  `server_plans[]` (matched by the compiler's `id === `${team}-${network}``
  convention). Absent/unparseable report or no interior self-teams -> `[]`
  (the office-sim golden legitimately yields none).
- `runWorldTrace.ts` — `buildRunWorldTrace`: adapts a `RunTimeline` plus the
  run's `world` (network/room/members) into the same `viewer.trace.v1` shape
  `web/src/viewer/worldModel.ts`'s `buildViewerWorld` already renders (one
  informational room anchor — these runs have no place-bearing world yet —
  heuristic agents, and `ledger_facts` keyed by `tick := t`).
- `runViewModelTypes.ts` — the `RunViewModel` shape (verdict, thread with
  per-turn causal trace, minds, provenance, engineProvenance) plus the raw
  transcript/mneme-event-log shapes read from disk. `thread`/`minds` are
  computed but no longer served whole; `/api/run-meta` exposes
  `verdict`/`provenance`/`engineProvenance`/`participants` plus increment 3's
  `seedSpread`/`spreadSummary`/`variableSamples` (the React shell gets its
  chat/minds content from `/api/timeline` instead — see
  `web/src/viewer/ReplayPanes.tsx`). `engineProvenance` is the one field
  that is never optional (unlike the increment-3 fields) — see
  `engineProvenance.ts` above.
- `runViewModelCompute.ts` — pure functions building the thread (message ->
  wake -> turn -> reply, plus the `mneme:`-cause "recall fed this turn" edge),
  the per-agent memory portals, the verdict, and provenance from
  already-loaded data. No I/O. `computeVerdict`/`computeProvenance` are the
  functions `/api/run-meta` serves — do not reimplement their logic in
  `server.ts` or in `web/`.
- `runViewModel.ts` — `buildRunViewModel(runDir)`: calls the existing
  `runObserve` (`../observe/`) for the reconciled report and causal streams,
  `runRawArtifacts.ts` for the transcript, mneme event logs, and any
  up-receipt engines, and assembles the `RunViewModel` — including
  `engineProvenance` via `engineProvenance.ts`'s `computeEngineProvenance`.

`runPage.ts` / `runPageStyles.ts` / `runPageScript.ts` (the bespoke
run-reader HTML page) and the `/api/run-view-model.json` endpoint they fed
are retired as of increment 2: the React shell renders verdict/provenance
at parity (`web/src/viewer/RunMetaPanels.tsx`), so there is no reason left
to keep the standalone page in the tree.

## Rules

- Keep command parsing small and deterministic.
- Keep the served surface intentionally minimal; this folder is the scaffold for
  the live-first viewer and not the full production viewer.
- Run-replay mode is observer-tier and read-only like the rest of this
  folder: it consumes `runObserve`'s public report, `runTimeline.ts`'s
  merged records, and the raw run-dir artifacts, never a privileged API,
  and never stitches an incomplete chain or invents a cause.
- Every field `runTimeline.ts`/`runWorldTrace.ts` emits must trace to a real
  record id (`docs/VIEW_DESIGN.md` rule 3) — no derived/invented text or causes,
  only real event ids, message ids, and memory ids already present in the
  raw data.
- Named exports only.
- Files stay concise so they stay easy to iterate on; split before 400 lines.
