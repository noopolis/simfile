# Simulation fixtures

This directory contains the small, maintained scenarios used by Simfile's
documentation and automated tests.

| Fixture | Local run | Spawnfile boundary | Purpose |
| --- | --- | --- | --- |
| `office-sim` | Yes, with `--local --ticks` | Linked source only; no composed binding yet | Minimal multi-agent organization example. |
| `office-secret-v0` | Yes, with `--local --ticks` | Linked source only; no composed binding yet | Seeded-memory and observation example. |
| `office-pressure-v0` | Yes, with `--local --ticks` | Linked source only; no composed binding yet | Deterministic world-variable example. |
| `jungian-daimon-org` | Fixture-specific harness | Not a linked composed example | Nested-team and membrane example. |
| `public-dynamics-contract` | Yes, recommended source quick start | None | Public dynamics API compile and runtime contract. |

“Spawnfile boundary” does not mean a full composed run. The canonical runnable
linked project is `../../examples/composed-development/`, not a fixture copy.
It contains the `world_sidecar` binding and is gated by Simfile's
`simfile.spawnfile-public-capability-probe.v1`, which uses only generic public
Spawnfile CLI surfaces.

Experimental simulations belong on a feature branch until they have a bounded
contract, an automated test, and a documented reason to remain in the reference
repository. Model-specific copies and captured experiments are not reference
fixtures.
