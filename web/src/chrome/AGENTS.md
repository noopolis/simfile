# Run-Replay Chrome

Global chrome for run-replay mode — UI that surrounds the map/portal panes
rather than living inside any one of them.

## Structure

- `ScrubBar.tsx` — the global scrub bar (`VIEW_DESIGN.md`'s "Time chrome"):
  play/pause, step ±1, jump to start/end, a slider over `[0, N-1]` with
  event-density ticks, and a readout naming the event at the current
  cursor. Drives `../store/timeline.ts`'s cursor directly; every other pane
  (map, chat, minds rail, storyline portal) reacts to that same cursor
  rather than owning its own clock. Its optional `tickDurationMs`/
  `firstTick`/`lastTick` props make the trace's corroborated simulated time
  the playback master clock while the cursor remains event-indexed. When a
  trace declares no usable timing, playback retains the pre-existing
  one-step-per-second pacing.
  Playback respects `prefers-reduced-motion` (disables auto-advance rather
  than silently ticking). Increment 3 adds a phase-band row and a `tick N ·
  phase` readout prefix (both from `clockModel.ts`'s `derivePhaseBands`/
  `currentClockReadout`, over the timeline's own `viewClass: "clock"`
  events — empty/absent for a run with no world clock stream) and, when
  the optional `seedSpreadEventIds` prop is passed, a row of "spread dots"
  marking the real `seed_spread` events on the track (`spreadDotEvents`).
- `clockModel.ts` — pure derivations over the `clock.sync` stream and a
  seed-spread event id set, kept outside `ScrubBar.tsx` so they're
  unit-testable without rendering React (this repo's test runner only
  picks up `.test.ts`, not `.test.tsx`): `derivePhaseBands`,
  `currentClockReadout`, `spreadDotEvents`.
- `playbackCadence.ts` — pure real-time cadence and elapsed-wall-time cursor
  derivations, including the watchable one-step-per-second floor. Its
  `playbackTickAtCursor` export is the single owner of the app's `cursor ->
  tick` mapping. A sample-backed spatial-only axis uses each
  `spatial.sample` row's explicit `payload.tick`, including irregular sample
  gaps; ordinary causal timelines retain the corroborated timestamp path. It
  answers in whole world ticks by rounding away the
  fractional artifact caused when ledger ISO timestamps truncate simulated
  time to whole milliseconds; its private continuous value remains available
  to elapsed-time cursor search. It contains no React, DOM, or timer code so
  sub-frame playback is deterministic in tests.

## Rules

- This bar is the only place the run-replay `requestAnimationFrame` playback
  loop may live; other components read the cursor, they do not advance it on
  a timer. Cadence math belongs in `playbackCadence.ts`, never inline in the
  component.
- Every control here must act through `../store/timeline.ts`'s exported
  actions — no local shadow state for cursor/playing/speed.
- Named exports only. Keep files under 400 lines.
