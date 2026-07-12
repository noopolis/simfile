# Simfile Composed-Run Sims

This folder implements the Piece 5 "compose-and-observe" composed-run driver
(Decision 21 / `contracts.md`'s Slice B pipeline, the "Piece 5 design (fable
pass)" block). It runs a Spawnfile org + a minimal Simfile world as one
COMPOSED sim through `spawnfile up/artifacts export/down --json`, then hands
the assembled run directory to `../observe` for reconciliation — this is the
path that retires the bespoke `src/e2e/officeSim.ts`-style harness in
Spawnfile once it is fully proven.

Memetics increment (a) adds a second driver alongside the original: instead
of one operator-authored seed message, the Simfile WORLD itself runs as a
live tick loop between "org ready" and "concluded" — see
`worldDrivenOfficeSimDriver.ts` below. Both drivers share this folder's
charter (seed/kickoff-once semantics, poll-read-only, CLI-only Spawnfile
access); the original `composedOfficeSimDriver.ts` is unchanged and still the
right choice for a plain (non-memetics) composed office-sim run.

## Files

- `spawnfileReceipts.ts` — local zod schemas + parsers for the three
  documented `spawnfile ... --json` outputs this driver consumes
  (`spawnfile.up-receipt.v1`, `spawnfile.export-index.v1` folded inside the
  `artifacts export --json` result, `spawnfile.down-receipt.v1`). Loose
  (`.passthrough()`) by design: this package treats each receipt as an
  external wire contract, never a Spawnfile-internal TS type.
- `spawnfileCli.ts` — shells `spawnfile up/artifacts export/down --json` as a
  subprocess (`node <spawnfileBin> ...`). The ONLY way this package talks to
  Spawnfile (`contracts.md`'s CLI rule: "simfile -> spawnfile only through
  documented CLI + versioned receipts" — never a raw `docker`/`git` call).
- `moltnetRoomClient.ts` — read-only Moltnet HTTP polling helpers
  (`/healthz`, `/v1/rooms/:id`, `/v1/agents`, `/v1/rooms/:id/messages`).
  Moltnet's own public wire API, reimplemented locally (never imported from
  Spawnfile's `src/e2e`) so this package never depends on Spawnfile
  internals.
- `poll.ts` — generic bounded-retry poll helper (`pollUntilReady`), used for
  every read-only readiness check before the driver's one seed write.
- `exchangeWait.ts` — the pure stop/continue decision
  (`evaluateExchangeCompletion`) and polling loop
  (`waitForConversationExchange`) for a bounded multi-turn Moltnet exchange.
  Ported from `src/e2e/moltnetExchangeWait.ts` (Spawnfile's own "pure,
  scenario-agnostic" version of the same logic) rather than imported, for the
  same charter reason as `spawnfileCli.ts`.
- `composeRunManifest.ts` — pure `simfile.run-manifest.v1` composer: folds
  `spawnfile artifacts export`'s `index.files` straight into `artifacts[]`,
  adds any extra driver-written artifact (the transcript), and stamps
  `contract_versions`/`world`/`engine`. No filesystem or clock access — the
  caller passes `createdAt` and already-hashed artifact entries in.
- `composedOfficeSimDriver.ts` — `runComposedOfficeSim`: the end-to-end
  orchestration (`up` -> poll-read-only -> seed ONCE -> poll-read-only until
  the exchange concludes -> `artifacts export` -> fetch the moltnet
  transcript while the container is still live -> `down` -> write
  `manifest.json` LAST). Returns the sealed run-dir path.
- `composedJungianSimDriver.ts` — `runComposedJungianSim`: the MULTI-NETWORK
  generalization for the recursive jungian psyche
  (`fixtures/sims/jungian-daimon-org/org`) — a floor network whose members are
  self-teams, each owning its own inner Moltnet council network. Reads the
  compile report's `server_plans[]` for each managed network's host base url +
  room membership (its ONE structured report read; everything else is HTTP
  polling), polls EVERY network ready, seeds the floor ONCE
  (`@luna-representative` into `commons`), then waits for the representative's
  floor-facing SYNTHESIS to reappear — a completion gate that can only be
  satisfied after the interior council deliberated and the representative
  crossed the membrane back out, so it proves the whole wake-across-membranes
  chain closed without ever coaxing it. Exports one transcript PER network
  (`raw/moltnet/<network_id>/transcript.json`), copies `spawnfile-report.json`
  into the run-dir (the viewer's named feed #1, the source of the derived
  membranes), and writes `manifest.json` with `world.rooms[]` (every room
  across every network) LAST. The cross-membrane posting itself is the
  scripted engine's own `moltnet send --network <inner> --target room:<council>`
  from its staged `.moltnet/config.json` — the pi bridge only ever
  auto-publishes a reply back to the room that woke an agent, so an inner-network
  post is an explicit send the agent (scripted or real) makes, never a driver
  action.
- `index.ts` — barrel (not re-exported from the package root barrel,
  mirroring `../observe`: this is a dev/ops driver, not public library API).

### Memetics increment (a): the world-driven variant

- `worldTickIngest.ts` — `ingestNewRoomMessages` (the tick's ONE read: GET the
  room, return only messages not yet in the cursor — the cursor mutation is
  the whole determinism contract) and `moltnetMessageToLedgerEvent` (lowers a
  room message to the `LedgerEvent` shape `scanMarkers` expects).
- `worldLedgerWriter.ts` — `createWorldLedgerWriter`: appends every tick's
  minted events to `raw/world/causal.jsonl` (via `../runtime/causal-fixture.ts`'s
  wire mapping — the same one B92's conformance harness validates), grows
  `world/telemetry.json` with each tick's variable sample, and appends the
  tick's ingested-message-id list to `world/ingested-messages.jsonl`.
- `worldSeedLint.ts` — `lintWorldRuleContentAgainstTokenSet` /
  `assertWorldRuleContentClean` (fails the run if any world rule's message
  content would itself contain a memetics seed token — the world must never
  speak the secret it is trying to observe spreading) and
  `buildSeedDeclarationFromMemoryDoc` (derives the manifest's
  `seed_declaration` — content hash, token set, matcher policy, seed agent,
  seed epoch, `entry_channel: "doc-seeded"` — from the seed agent's own
  `workspace.docs.memory` file, never hand-typed twice).
- `worldTickLoop.ts` — `runLiveTickLoop`: one iteration per wall-clock
  `clock.tick`. Ingest -> `stepSimfileTick` -> scan the tick's own newly
  ingested messages for marker tokens (never the whole transcript, never the
  world's own minted events) -> deliver any rule-emitted
  `world.message`/`world.dm`/`wake.recommended` -> append to the world
  ledger -> decide stop/continue with the same pure
  `evaluateExchangeCompletion` the batch driver uses. A `marker.seen` hit's
  `cause_event_ids` is that tick's own `clock.sync` ONLY — the Moltnet
  message id that carried the token rides along as `source_event_id` in
  payload, a display/measurement join, never a synthesized causal parent —
  so stele reconciliation over the world stream stays complete.
- `worldDrivenOfficeSimDriver.ts` — `runWorldDrivenOfficeSim`: `up` ->
  poll-read-only -> `runLiveTickLoop` (replaces the old driver's "seed once,
  then wait" step entirely — the room's opening message is the world's own
  `kickoff` rule now, not a driver-authored string) -> `artifacts export` ->
  fetch transcript -> `down` -> compose `manifest.json` (with
  `seed_declaration`) LAST.

## Rules

- Seed-once + poll-read-only, always. Every retry loop in this folder is a
  read (`pollUntilReady`, `waitForConversationExchange`); the only write in
  `composedOfficeSimDriver.ts` is its single `sendWorldEventToMoltnet` seed
  call. If a real run needs a second seed/mention/nudge to complete, that is
  a platform gap in the layer that owns it (Phase B) — file it, never code
  around it here by resending.
- No Docker, no runtime auth, no Spawnfile TS imports. Every Spawnfile
  interaction goes through `spawnfileCli.ts`'s three shelled subcommands and
  their versioned receipts.
- Keep files under 400 lines; split further before that limit.
- **Charter amendment (memetics increment (a)):** the driver performs no
  ad-hoc writes; every write is a world-ledger-recorded kernel action
  delivered through the world-participant, capped at nudge; wake coalescing
  (supersede-never-queue) is mechanics; coaxing (re-sending because an agent
  didn't reply) remains a Phase-B defect to file, not code. This extends the
  seed-once rule above to the live world-driven loop: `worldTickLoop.ts`
  never re-sends a world event and never re-polls with an altered request
  hoping for a different answer — every event it delivers came from stepping
  the world exactly once, and every stop decision is the same read-only
  `evaluateExchangeCompletion` the batch driver already uses.
