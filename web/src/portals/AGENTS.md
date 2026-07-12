# Run-Replay Portals

Placeless-scope portals for run-replay mode (`VIEW_DESIGN.md`'s two-layer
rule: everything with a place renders on the map; everything else opens as
a portal).

## Structure

- `StorylinePortal.tsx` — the ONE storyline portal for every element kind
  (`agent:` | `room:` | `bank:` refs all render through this same
  component — no per-kind portal code): opened by
  `../store/timeline.ts`'s `focusAndOpenPortal`, called from the map
  (room anchor, agent body), the chat pane (author name), and the minds
  rail (bank header, per-agent sub-header). Multiple portals can be open
  at once (`openPortals` is a stack); `stackIndex` offsets each instance so
  they don't overlap. Renders that element's own timeline slice
  (`eventsForElement`) as a vertical strip in `t` order, with a "now" line
  at the global cursor — rows past it are dimmed, not hidden. Clicking a
  row jumps the *global* cursor (`setCursor`), never a private one, so the
  portal always time-links back to the map/chat/minds rail (rule 7). A
  `turn.input` row also renders `RecallChips`, and any row whose event id
  is in the shared `highlightedEventIds` set renders with the
  `highlighted` class (the cross-portal linked-selection mechanism).
- `RecallChips.tsx` — renders a `turn.input` event's `mneme:`-caused recall
  edge as chips; shared between this portal and
  `../viewer/ReplayPanes.tsx`'s chat trace so there is one recall-chip
  implementation, not two. Hovering/clicking a chip sets
  `../store/timeline.ts`'s `highlightedEventIds`, which is how a recall
  chip highlights the matching `memory.recalled` row in any *other* open
  portal without any direct component-to-component reference.

## Rules

- A portal never keeps its own cursor or its own copy of timeline data; it
  reads `../store/timeline.ts` directly.
- Closing a portal (`closePortal(elementRef)`) must close only that one
  portal and must not affect the global cursor, the map/chat `selection`,
  or any other open portal — closing is looking away, not an event.
- Do not add a second portal component for a different element kind. If a
  new kind needs different content, extend `StorylinePortal`'s rendering,
  not the open mechanism.
- Named exports only. Keep files under 400 lines; split before that.
