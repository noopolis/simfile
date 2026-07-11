# Simfile Composed-Run Sims

This folder implements the Piece 5 "compose-and-observe" composed-run driver
(Decision 21 / `contracts.md`'s Slice B pipeline, the "Piece 5 design (fable
pass)" block). It runs a Spawnfile org + a minimal Simfile world as one
COMPOSED sim through `spawnfile up/artifacts export/down --json`, then hands
the assembled run directory to `../observe` for reconciliation — this is the
path that retires the bespoke `src/e2e/officeSim.ts`-style harness in
Spawnfile once it is fully proven.

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
- `index.ts` — barrel (not re-exported from the package root barrel,
  mirroring `../observe`: this is a dev/ops driver, not public library API).

## Rules

- Seed-once + poll-read-only, always. Every retry loop in this folder is a
  read (`pollUntilReady`, `waitForConversationExchange`); the only write is
  the single `sendWorldEventToMoltnet` seed call in
  `composedOfficeSimDriver.ts`. If a real run needs a second seed/mention/nudge
  to complete, that is a platform gap in the layer that owns it (Phase B) —
  file it, never code around it here by resending.
- No Docker, no runtime auth, no Spawnfile TS imports. Every Spawnfile
  interaction goes through `spawnfileCli.ts`'s three shelled subcommands and
  their versioned receipts.
- Keep files under 400 lines; split further before that limit.
