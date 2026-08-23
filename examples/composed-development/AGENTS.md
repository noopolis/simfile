# Composed Development Example Guide

This example is the smallest standalone linked Simfile/Spawnfile project used
to prove source-checkout authoring, world-sidecar preparation, paused readiness,
and exact mechanics replay without Docker.

- Example JavaScript may import only documented `simfile/*` package exports,
  Node built-ins, local example modules, or the emitted sidecar
  `./entrypoint.mjs` / `./provider.mjs` surfaces.
- Never import `src/**`, a sibling checkout, a global installation, or a
  machine-specific path.
- The scripted agent has no world-action ingress. Keep the evidence honest:
  this example does not claim or fabricate a live agent action.
- Every controller loop must have a fixed terminal tick and every close path
  must settle without polling or an unbounded timer.
- Keep the example README explicit about what the smoke does and does not
  evaluate.
- `binding.mjs` owns the public binding; `binding-world.mjs` holds its
  deterministic kernel/replay fixture and evidence map.
