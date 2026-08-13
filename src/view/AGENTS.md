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

- `runFollowLocator.ts` — read-only detection of an in-progress dynamics run;
  a sealed `manifest.json` wins over leftover staging, and ambiguous staging
  fails closed.
- `runLiveBundle.ts` — selects the one open run-follow staging directory while
  leaving sealed replay assembly to `runReplayBundle.ts`.
- `runLiveFollow.ts` — follows the staging `raw/frames.jsonl` with `fs.watch`
  plus a bounded 200ms fallback, serves the live world projection and frame SSE,
  and treats the final staging rename as a sealed end-of-stream. It only reads;
  backpressured clients receive dropped-frame counts rather than an unbounded
  queue. `/api/run-meta` exposes timing evidence while explicitly withholding
  run identity, verdict, provenance, and engine provenance until seal.
- `runSealFollower.ts` — server-owned manifest polling and reconciliation for
  a live run. It promotes extension identity from `live` to `recorded` only
  after the final manifest is independently discovered and reconciled; this
  lifecycle does not depend on a browser or SSE subscriber. Its bounded
  terminal wait lets an owning observer acknowledge `recorded|failed` before
  closing the one live-to-sealed URL.
- `runViewerExtensionData.ts` — loads only manifest-declared, hash-verified
  JSON payloads for viewer extensions. Payloads remain opaque to Simfile; all
  scenario vocabulary and interpretation belongs to the declaring fixture. A
  live staging declaration is likewise hash-bound and opaque.
- `runViewerProjection.ts` — loads an optional sealed `viewer.trace.v1` base
  only from `manifest.world.viewer_projection`. The path must be listed once
  in `manifest.artifacts`, remain inside the run directory, match its recorded
  hash, and correlate to the manifest run id before `runReplayBundle.ts`
  overlays any recorded frame track.
- `runViewerExtensions.ts` — resolves the recorded extension set and the
  caller-supplied live startup set. Executable module and asset paths come only
  from the caller-selected trusted project declaration and descriptor;
  recorded provenance/declarations are never loading authority. A recorded
  declaration corroborates the trusted token, id, module digest, and asset-tree
  digest exactly. A live extension is identified as `unsealed/local` until
  seal, then promoted to `recorded` only after reconciliation; any mismatch or
  post-start content mutation fails the extension route closed with HTTP 409.
- `runReplayBundle.ts` — assembles run-replay timeline, world trace, and meta
  data away from the HTTP server so loading and serving stay separate.
- `/api/run-lifecycle` serves one post-seal bundle containing the timeline,
  world, and run metadata together, so a live client cannot display recorded
  identity beside stale pending run id, verdict, or provenance.
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
  agents). When `manifest.world.decision_source` exists, its
  `provenance`/`model_decisions`/`live_acceptance` fields outrank engine-name
  hints when they positively classify the record. `scripted` requires an
  explicit `false` for `model_decisions` or `live_acceptance`, or a string
  `provenance` other than `live`; `true` for both model decisions and live
  acceptance yields `real-engine`. Missing or malformed fields have no
  classification. An inconclusive present decision source falls through to
  the unchanged engine-name path rather than suppressing it.
  `classifyEngineName` maps one engine string to `"scripted"`
  (`fake-*`/exactly `"scripted"`), `"real-engine"` (a recognized model name
  — `grok`/`codex`/`agy`/`claude`, matched as a whole segment so
  `claude-sonnet-4.5` still matches but `agyeman` does not), or `"unknown"`
  — absence or an unrecognized string NEVER collapses to real.
  `computeEngineProvenance` folds a list of `{agent?, engine}` entries into
  one `EngineProvenance` (`mode`/`engines`/`label`): all-agree -> that
  classification; disagree -> `"mixed"` (itself a disclosure, listing each
  agent's own engine in the label). `runViewModel.ts` first narrows the
  already-loaded `manifest.world.decision_source` and passes it as the
  authoritative override; it never reads another artifact for this fact.
  Engine names are the fallback path: either `spawnfile/up-receipt.json`'s
  per-agent `engines[]` (`readUpReceiptEngines` in `runRawArtifacts.ts`, when
  a composed run-dir has one) or the manifest's single `engine` field
  collapsed to one entry. The `decision_source.kind` value is an ingress seam,
  not evidence that a model decided, so `kind` alone must never be the
  classification switch or a reason to badge `scripted`/`real-engine`.
- `runDetect.ts` — `isObserveRunDir`: the shape check that selects
  run-replay mode (never touched when `--state` is passed — that always
  means the world live mode). Keys ONLY on `manifest.json` @
  `simfile.run-manifest.v1`. It used to also demand a moltnet transcript,
  which sent every transcript-free `simfile run` record down the world/3D
  replay path and straight into "Replay artifact check failed" (B192). Do
  not reintroduce a transport-shaped precondition.
- `runFrames.ts` — `readRunFrames`/`runFrameAgents`/`runFrameRoom`/
  `applyRunFrameTrack`: reads the run record's motion track
  (`raw/frames.jsonl`, written once by `src/run/dynamics-run-frames.ts`) and
  folds it into the existing `viewer.trace.v1` fields the React client already
  animates — `spatial_samples[].objects[]`, plus the `agents[]` entries
  without which nothing renders at all, a floor sized from the recorded
  bounds, and `tick_duration_ms`. No new viewer contract and no second copy of
  any event stream. An open staging reader stops at a torn final line, while a
  sealed reader requires one manifest entry, in-run realpath, matching hash,
  and complete parse before rendering.
  Its optional `timing` rows preserve measured wall elapsed beside simulated
  seconds advanced, and `simSecondsPerTick` preserves the declared rate; these
  are evidence inputs, not a keep-up verdict.
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
  event's own `content`; wake view records are Daimon control-wake records
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
  `engineProvenance` via `engineProvenance.ts`'s `computeEngineProvenance`,
  with the manifest's narrowed `decision_source` taking precedence over engine
  names. A present but inconclusive decision source deliberately falls through
  to that path; `kind` alone is deliberately not trusted. Its optional `pace`
  is passed through from `world_evidence.pace` when the record states it — no
  zero-valued timing or `kept_up` verdict is fabricated when absent. The
  viewer's `runFrames.timing` rows are likewise exposed as optional timing
  evidence alongside that pace field.

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
- Generic viewer plumbing may pass opaque extension data, extension identity,
  and the existing replay cursor. It must not parse a fixture's domain model,
  invent a cursor-to-domain-time join, or infer actions from displayed text.
- Named exports only.
- Files stay concise so they stay easy to iterate on; split before 400 lines.
