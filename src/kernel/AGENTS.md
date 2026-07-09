# Simfile Kernel Utilities

This folder holds deterministic simulation kernel helpers (parsing and RNG math)
with no I/O.

- `duration.ts` parses duration literals used by clock and probe timing.
- `range.ts` parses `lo..hi` range literals.
- `stochastic.ts` maps `SHA-256(run_seed:generator_id:tick:draw_index)` to a
  deterministic uniform sample.

Files are small, pure, and testable.
