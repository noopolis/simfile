# Simulation fixtures

This directory contains the small, maintained scenarios used by Simfile's
documentation and automated tests.

| Fixture | Purpose |
| --- | --- |
| `office-sim` | Minimal multi-agent organization example. |
| `office-secret-v0` | Seeded-memory and observation example. |
| `office-pressure-v0` | Deterministic world-variable example. |
| `jungian-daimon-org` | Nested-team and membrane example. |
| `public-dynamics-contract` | Public dynamics API compile and runtime contract. |

Experimental simulations belong on a feature branch until they have a bounded
contract, an automated test, and a documented reason to remain in the reference
repository. Model-specific copies and captured experiments are not reference
fixtures.
