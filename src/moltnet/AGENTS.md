# Simfile Moltnet Runtime Helpers

This folder contains Simfile-to-Moltnet bridge helpers for posting mechanical world
events to Moltnet participants.

- `world-participant.ts` maps `world.message`, `world.dm`, and `wake.recommended`
  events into Moltnet `/v1/messages` requests.
- `transcript-export.ts` reads room and DM transcripts back from Moltnet and marks
  them as the accepted `moltnet-exported` social record.

Rules:

- Use existing Simfile event data from `runtime` output; no schema or planner logic.
- Keep HTTP transport deterministic and side-effect boundaries explicit for easy testing.
- Preserve Simfile ledger identity by including `event_id` in request metadata.
- Treat harness-derived transcript artifacts as diagnostics only; live acceptance
  requires a Moltnet-exported transcript.
