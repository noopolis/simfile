# Runtime

This folder contains deterministic Simfile runtime helpers.

- `clock.ts` resolves tick, simulated time, and phases.
- `condition.ts` evaluates the shared `when:` condition tree.
- `expression.ts` evaluates the closed arithmetic `eq` subset.
- `numeric.ts` is the shared `RangeSpec`/`clampAndRound` primitive used by both
  `trace-run.ts` and `rule-actions.ts`.
- `trace-compile.ts` prepares runtime state from a parsed Simfile, including
  `variableFedBy` (declared `fed_by` writer per fed variable) and
  `variableScopes` (declared scope per variable) — both consumed by
  `world-act.ts` for act authorization and envelope scope.
- `rule-actions.ts` lowers a fired rule's `do:` actions into world-effect
  events (`world.message`, `world.dm`, `wake.recommended`) or variable
  mutations. Every world-effect event is a world.act variant and carries the
  payload minimum `{sim_time, provenance, actor, target, scope, act_id,
  action, value}`.
- `world-act.ts` is the generic `world.act` protocol: the single act surface
  is `variable:set` on a declared `fed_by` variable. `validateWorldAct`
  applies the six-code ingestion order (dedup, run_closed, unknown_variable,
  not_authorized, not_finite, out_of_range — reject, never clamp);
  `ingestWorldActs` validates a whole queued batch up front (acts are
  deterministic-driver-supplied, not live agent calls, so ranges/fed_by/tick
  count are static for the run) and groups accepted acts by `at_tick`;
  `applyWorldActsAtTick` applies a tick's accepted acts (last write wins on a
  shared var/tick) and mints each as a canonical `world.act` ledger event with
  `provenance: "agentic"`. Live agent tool binding is a later item — this
  module is the mechanics only.
- `step-tick.ts` is the per-tick engine extracted out of `trace-run.ts`
  (memetics increment (a)): `stepSimfileTick(tick, ctx)` resolves the clock,
  applies that tick's queued world.acts, runs generators, recomputes derived
  variables, and evaluates rules — mutating `ctx.state` in place and
  returning the tick's events + variable sample + next seq. It also owns
  `createTraceEvent`, the one canonical-envelope constructor every
  simfile-native trace event (batch or live) is stamped through. This is the
  seam a live driver calls once per wall-clock tick
  (`../sims/worldTickLoop.ts`) instead of only ever inside one big batch
  loop; the batch loop below is now a thin caller of it.
- `trace-run.ts` loops `stepSimfileTick` once per tick over the whole bounded
  run, then does the one thing a live per-tick call can't: a post-hoc
  `scanMarkers` pass over the whole run's events, minting `marker.seen`
  events causing from the marker hit's own source event. Every event's
  causal envelope (`run_id`, `emitter{system:"simfile", stream_id:"world",
  seq}`, `principal_id:"system:simfile.world"`, `recorded_at`,
  `cause_event_ids`) is stamped by `step-tick.ts`'s `createTraceEvent` — see
  `src/ledger/stable.ts`. Rule-fired events cause from that tick's
  `clock.sync` event; rule-emitted world-effect events cause from their
  rule's `rule.fired` event. Queued world.acts (`RuntimeOptions.worldActs`)
  are applied at the start of each tick, after that tick's `clock.sync` and
  before generators/derived/rules, via `world-act.ts`.
- `causal-fixture.ts` maps a runtime trace event onto the
  `noopolis.causal-event.v1` wire shape (root `specs/causal-event.v1.schema.json`
  — referenced, never imported). This is B92's real conformance target.
- `emit-causal-fixture.ts` is the thin `npm run emit-causal-fixture` entry
  point: prints one schema-shaped JSONL record per line to stdout, no banner.
- `run-record.ts` writes sealed run-record artifacts and re-exports the
  causal-fixture builder for a single import surface.
- `trace.ts` is the folder barrel.

Runtime modules must stay independent from Spawnfile internals and browser UI code.
They may produce public artifacts for the viewer, but they must not add Simfile
authoring surface for presentation concerns.
