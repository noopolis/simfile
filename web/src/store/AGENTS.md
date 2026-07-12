# Run-Replay Store

This folder holds the one external store the run-replay viewer's
time-linked views subscribe to (`VIEW_DESIGN.md` rule 7: time is one axis
everywhere, and portals/panes must rewind together, never keep private
clocks).

## Structure

- `timeline.ts` — `timelineStore` (a plain pub/sub external store, not
  React Context) holding the loaded `RunTimeline`, the integer scrub
  cursor, playback state (`playing`/`speed`), and the current `selection`
  (an `ElementRef`). Exposes action functions (`loadTimeline`, `setCursor`,
  `stepBy`, `jumpStart`/`jumpEnd`, `play`/`pause`/`togglePlay`,
  `setSpeed`, `setSelection`) and pure selectors (`eventsUpTo` — the
  prefix-slice "as of cursor" invariant every pane relies on;
  `eventsForElement` — one element's own storyline). `useTimelineStore()`
  is the `useSyncExternalStore`-based hook every component reads from.

## Rules

- Exactly one store instance (module-level singleton) — do not wrap this
  in a Context provider or instantiate a second store; the time-link
  guarantee depends on every consumer reading the same cursor.
- `eventsUpTo` must never return an event with `t > cursor`. Any new
  selector that derives an "as of" view must go through this same
  invariant, not re-implement its own filter.
- The types here (`RunTimeline`, `TimelineEvent`, `ElementRef`, ...) are a
  structural mirror of `src/view/runTimelineTypes.ts`'s server-side types —
  a deliberate duplicate of the `/api/timeline` JSON contract, not a
  cross-package import (this repo's `web/src` never imports from `src/`).
  Keep them in sync by hand when the server contract changes.
- Named exports only. Keep this file under 400 lines; split before that.
