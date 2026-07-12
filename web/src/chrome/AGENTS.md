# Run-Replay Chrome

Global chrome for run-replay mode — UI that surrounds the map/portal panes
rather than living inside any one of them.

## Structure

- `ScrubBar.tsx` — the global scrub bar (`VIEW_DESIGN.md`'s "Time chrome"):
  play/pause, step ±1, jump to start/end, a slider over `[0, N-1]` with
  event-density ticks, and a readout naming the event at the current
  cursor. Drives `../store/timeline.ts`'s cursor directly; every other pane
  (map, chat, minds rail, storyline portal) reacts to that same cursor
  rather than owning its own clock. Playback respects
  `prefers-reduced-motion` (disables the auto-advance interval rather than
  silently ticking).

## Rules

- This bar is the only place a `setInterval`-driven playback loop may live;
  other components read the cursor, they do not advance it on a timer.
- Every control here must act through `../store/timeline.ts`'s exported
  actions — no local shadow state for cursor/playing/speed.
- Named exports only. Keep files under 400 lines.
