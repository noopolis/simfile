# Autonomous Office Simulation

This fixture models a Portland neighborhood-law office in a shared simulation world.
Agents move between work, home, and friend contexts while keeping practical continuity.

The fixture is intentionally neutral at the world layer: place case and private
obligations in team-specific docs so that each context can enforce its own
boundary.

Shared runtime topology:

- The `office-floor` Moltnet network links all rooms.
- `./office-world/bin/office-clock` gives the shared timing for all contexts.
- Office continuity is stored in the office-team resource `./office-case`.

## Operator Entry Points

- `spawnfile up fixtures/e2e/autonomous-office-sim`
  Live operator entrypoint for the compiled office runtime and managed
  `office-floor` Moltnet server. Use this when Moltnet itself must be the
  social source of truth. Collect the managed Moltnet export and the
  Daimon/runtime logs from that run.

- `simfile run fixtures/e2e/autonomous-office-sim/office-world/Simfile`
  World-mechanics entrypoint. Collect `simfile-run/manifest.yaml`,
  `simfile-run/ledger.jsonl`, `simfile-run/report.json`, and
  `simfile-run/viewer-trace.json`.

- `npm run test:e2e:autonomous-office-sim -- --cycles 1 --keep-artifacts --out <dir>`
  Deterministic fixture-harness validation entrypoint. It compiles the same
  fixture, runs the generated Daimon app directly, runs `simfile run`, injects
  harness control wakes, and writes `index.md` plus the harness-derived
  Moltnet/Mneme/report artifacts into `<dir>`. Treat its Moltnet export as a
  placeholder until a live `spawnfile up` run exports managed Moltnet state.

Source labels used in generated run folders:

- `spawnfile-runtime`: output emitted by the generated Daimon/Pi runtime.
- `simfile-run`: output emitted by the Simfile CLI.
- `fixture-harness`: output emitted only by the deterministic E2E harness.
- `harness-derived`: summaries or placeholder exports synthesized by the harness.

Office teams and family/friend teams share:

- `office-hall`
- `case-warroom`
- `boss-office`
- `break-room`
- `neighborhood`
- `eleanor-home`, `maya-home`, `theo-home`, `priya-home`
- `after-work-chat`

Keep routing behavior in team-level TEAM docs and respect room context before cross-room assumptions.
