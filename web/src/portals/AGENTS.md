# Run-Replay Portals

Placeless-scope portals for run-replay mode (`VIEW_DESIGN.md`'s two-layer
rule: everything with a place renders on the map; everything else opens as
a portal).

## Structure

- `StorylinePortal.tsx` — the ONE storyline portal for every element kind
  (`agent:` | `room:` | `bank:` | `team:` | `variable:` refs all render
  through this same component — no per-kind portal code): opened by
  `../store/timeline.ts`'s `focusAndOpenPortal`, called from the map
  (room anchor, agent body, and now the synthesized `team:` node), the chat
  pane (author name), and the minds rail (bank header, per-agent
  sub-header). Multiple portals can be open at once (`openPortals` is a
  stack); `stackIndex` offsets each instance so they don't overlap. The
  branch that decides content is pure data presence
  (`../store/timeline.ts`'s `membraneForRef`): when `elementRef` names a
  real `RunTimeline.membranes` entry, it renders `MembraneView` (the
  recursive membrane portal, `VIEW_DESIGN.md` rule 5's "descend into a
  mind"); otherwise it renders the original flat strip via
  `StorylineRows` — a leaf agent/room/bank (every office-sim element) is
  byte-identical to before membranes existed. An agent that happens to be
  some membrane's own representative (`membraneForRepresentative`) gets an
  extra boundary note + a "descend ⤵" button in its own flat portal, which
  calls `focusAndOpenPortal(membrane.ref)` — the same open mechanism, so
  descending is just another stack push, and further descent from inside a
  membrane portal (e.g. clicking `luna-shadow`) recurses through this exact
  path again. The breadcrumb (`breadcrumbSegments`) shows the real nested
  path, computed from `openPortals` + `timeline.membranes` — no portal
  tracks its own "path" prop. **Variable storyline (increment 4):** a
  `variable:<id>` ref (never a membrane) renders `VariableTrajectoryPanel`
  (defined in this file) ABOVE the shared `StorylineRows` strip — the
  value-at-cursor + a `../viewer/RunMetaPanels.tsx`-exported
  `VariableSparkline` of the trajectory (`../viewer/variableModel.ts`'s
  `sampleAtTick`/`trajectoryUpToTick`, fed by the `variableSamples`/
  `variableTick` props `RunReplayShell.tsx` passes to every open portal),
  plus a scrollable tick→value list. The samples themselves are RECORDS
  from `world/telemetry.json`, not `TimelineEvent`s, so they render here
  rather than through `StorylineRows`; the "caused" rule-firing/message
  events still come from the ordinary `eventsForElement` slice below them
  (`buildWorldRecord`'s `variable:<id>` subjects put them there) — one
  storyline, two record sources, no special-casing of the open mechanism.
- `MembraneView.tsx` — the membrane interior view rendered inside a
  membrane's `StorylinePortal`: a mini interior map (built from
  `membrane.interiorWorld`, the same `buildViewerWorld`/`AsciiMap` the outer
  map uses — one map renderer, not two), the interior room's `ChatPane`
  (scoped via its `roomFilter` prop to `membrane.interiorRooms`), and a
  `MindsRail` filtered to `agentsForMembrane`/`banksForMembrane`. All three
  read the store's cursor directly — no private clock. A "crossings" tab
  keeps the membrane's own flat storyline available (the representative's
  combined interior+exterior storyline — where interior meets exterior),
  reusing `StorylineRows`.
- `StorylineRows.tsx` — the shared vertical "now"-lined event-row list, split
  out of `StorylinePortal.tsx` so both the flat leaf rendering and
  `MembraneView`'s "crossings" tab use one row renderer, never two copies of
  the now-line/highlight/recall-chip logic. Rows past the global cursor are
  dimmed, not hidden; clicking a row jumps the *global* cursor (`setCursor`),
  never a private one, so every consumer stays time-linked (rule 7). A
  `turn.input` row also renders `RecallChips`, and any row whose event id is
  in the shared `highlightedEventIds` set renders with the `highlighted`
  class (the cross-portal linked-selection mechanism).
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
  not the open mechanism — `MembraneView`/`StorylineRows` are internal
  rendering helpers `StorylinePortal` composes, not a second open
  mechanism; there is still exactly one `<aside>` and one `openPortals`
  stack.
- The membrane-vs-leaf branch is data presence
  (`timeline.membranes`/`membraneForRef`), never a per-run or per-fixture
  special case. A run with no membranes (office-sim, office-secret) must
  render identically whether or not this branch exists in the code.
- Named exports only. Keep files under 400 lines; split before that.
