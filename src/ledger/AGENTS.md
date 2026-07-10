# Simfile Ledger Helpers

This folder holds deterministic ledger primitives with no process or network I/O:

- `stable.ts` implements canonical JSON serialization and deterministic event envelopes. The
  envelope carries simfile's native copy of the shared `noopolis.causal-event.v1` wire contract
  (see `specs/causal-event.v1.schema.json` and `specs/CAUSAL.md` at the repo root — referenced,
  never imported): `version`, `run_id`, `emitter{system:"simfile",stream_id,seq}`, `principal_id`,
  `recorded_at`, `cause_event_ids`, plus simfile's own `kind`/`sim_time`/`actor`/`target`/`scope`
  fields. `event_id` is `simfile:<runId>:<seq>`.
- `validation.ts` validates canonical ledger JSONL against that envelope shape and generalizes
  seq contiguity to per-(run_id, stream_id) groups (1-based, gapless within a stream).
- `markers.ts` scans ledger events for marker aliases and computes simple marker outcomes.

Helpers are pure and intentionally small for isolated unit testing.
