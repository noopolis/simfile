# Legacy Simulation Utility Guide

This folder contains bounded simulation-fixture utilities retained for public
package compatibility. It is not the production CLI composition path.

- Do not add new product behavior here without a production importer and an
  explicit ownership decision.
- Keep utilities deterministic, timer-bounded, and free of checkout-relative
  paths or service lifecycle ownership.
- Prefer current `src/run/`, `src/compose/`, and `src/world/` authorities for
  new implementation work.
