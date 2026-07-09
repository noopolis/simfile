# Simfile Ledger Helpers

This folder holds deterministic ledger primitives with no process or network I/O:

- `stable.ts` implements canonical JSON serialization and deterministic event envelopes.
- `markers.ts` scans ledger events for marker aliases and computes simple marker outcomes.

Helpers are pure and intentionally small for isolated unit testing.
