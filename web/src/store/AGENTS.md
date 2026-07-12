# Run-Replay Store

This folder holds the one external store the run-replay viewer's
time-linked views subscribe to (`VIEW_DESIGN.md` rule 7: time is one axis
everywhere, and portals/panes must rewind together, never keep private
clocks).

## Structure

- `timeline.ts` — `timelineStore` (a plain pub/sub external store, not
  React Context) holding the loaded `RunTimeline`, the integer scrub
  cursor, playback state (`playing`/`speed`), the current `selection` (an
  `ElementRef` — the map/chat focus), the `openPortals` stack (every
  currently open storyline portal, any element kind), and
  `highlightedEventIds` (the recall -> turn cross-portal linked-selection
  set). Exposes action functions (`loadTimeline`, `setCursor`, `stepBy`,
  `jumpStart`/`jumpEnd`, `play`/`pause`/`togglePlay`, `setSpeed`,
  `setSelection`, `openPortal`/`closePortal`/`setOpenPortals`,
  `focusAndOpenPortal` — the one open-trigger every element kind shares,
  `setHighlightedEventIds`/`clearHighlightedEventIds`) and pure selectors
  (`eventsUpTo` — the prefix-slice "as of cursor" invariant every pane
  relies on; `eventsForElement` — one element's own storyline, whatever
  kind; `recallEventsForTurnInput` — resolves a `turn.input` event's
  `mneme:`-prefixed causes to their real `memory.recalled` rows).
  `useTimelineStore()` is the `useSyncExternalStore`-based hook every
  component reads from.
- `deepLink.ts` — pure `parseDeepLink`/`serializeDeepLink`/`currentDeepLink`/
  `applyDeepLink` over the `?at=<event_id>&sel=<elementRef>&portals=<comma-refs>`
  URL shape (anchored on `event_id`, never the dense index `t`, so a link
  survives timeline re-derivation), plus `startDeepLinkSync` — the only
  function here that touches `window.history`/`window.location`, throttled
  so scrubbing doesn't spam `replaceState`.

## Rules

- Exactly one store instance (module-level singleton) — do not wrap this
  in a Context provider or instantiate a second store; the time-link
  guarantee depends on every consumer reading the same cursor.
- `eventsUpTo` must never return an event with `t > cursor`. Any new
  selector that derives an "as of" view must go through this same
  invariant, not re-implement its own filter.
- `openPortals` is a stack, not a single selection — opening one portal
  must never evict another. `focusAndOpenPortal` is the only entry point
  UI code should call to open a portal; do not add a second, kind-specific
  open path (agent-only, room-only, bank-only).
- The types here (`RunTimeline`, `TimelineEvent`, `ElementRef`, ...) are a
  structural mirror of `src/view/runTimelineTypes.ts`'s server-side types —
  a deliberate duplicate of the `/api/timeline` JSON contract, not a
  cross-package import (this repo's `web/src` never imports from `src/`).
  Keep them in sync by hand when the server contract changes.
- `deepLink.ts`'s parse/serialize/apply/current functions must stay pure
  (no DOM access) so they can be unit-tested without a browser; only
  `startDeepLinkSync` may touch `window`.
- Named exports only. Keep files under 400 lines; split before that.
