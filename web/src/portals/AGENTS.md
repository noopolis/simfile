# Run-Replay Portals

Placeless-scope portals for run-replay mode (`VIEW_DESIGN.md`'s two-layer
rule: everything with a place renders on the map; everything else opens as
a portal).

## Structure

- `StorylinePortal.tsx` — the agent storyline portal: opened by clicking an
  agent (map node, chat author, or minds-rail header sets
  `../store/timeline.ts`'s `selection` to an `agent:<id>` ref). Renders
  that element's own timeline slice (`eventsForElement`) as a vertical
  strip in `t` order, with a "now" line at the global cursor — rows past it
  are dimmed, not hidden. Clicking a row jumps the *global* cursor
  (`setCursor`), never a private one, so the portal always time-links back
  to the map/chat/minds rail (rule 7).

## Rules

- A portal never keeps its own cursor or its own copy of timeline data; it
  reads `../store/timeline.ts` directly.
- Closing a portal (`setSelection(null)`) must not affect the global
  cursor — closing is looking away, not an event.
- Named exports only. Keep files under 400 lines; split before that.
