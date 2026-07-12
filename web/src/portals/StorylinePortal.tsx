import { useMemo } from "react";

import {
  breadcrumbSegments,
  closePortal,
  eventsForElement,
  focusAndOpenPortal,
  membraneForRef,
  membraneForRepresentative,
  useTimelineStore,
  type ElementRef,
} from "../store/timeline.js";
import { MembraneView } from "./MembraneView.js";
import { StorylineRows } from "./StorylineRows.js";

const labelFor = (ref: ElementRef): string => ref.split(":").slice(1).join(":") || ref;

const PORTAL_STACK_WIDTH = 336;

/**
 * Every placeless scope opens as a portal (`VIEW_DESIGN.md`'s two-layer
 * rule), and this is the one storyline renderer for every element kind:
 * `agent:`, `room:`, and `bank:` refs all render through the exact same
 * component (increment 2 rule 1 — "one mechanism, all element kinds, no
 * per-kind portal code"), because `eventsForElement` already slices by
 * subject membership regardless of what kind of ref it is.
 *
 * The branch that matters for the recursive membrane portal (increment 4):
 * when `elementRef` names a membrane (`../store/timeline.ts`'s
 * `membraneForRef` — a real `RunTimeline.membranes` entry, e.g. `team:luna`),
 * this renders `MembraneView` instead of the flat strip — the mini interior
 * map + interior chat + minds rail, all reading the same store cursor. This
 * is a DATA-PRESENCE branch, not a per-run special case: a leaf agent/room
 * (no membrane, e.g. every office-sim element) falls through to the exact
 * flat rendering that existed before membranes did, via the shared
 * `StorylineRows` component. An agent that happens to BE some membrane's own
 * representative additionally gets a boundary note and a "descend ⤵" button
 * in its own (still flat) portal — descending pushes the membrane's portal
 * onto the stack, the same `focusAndOpenPortal` mechanism as every other
 * open, so recursion (`luna` -> `luna-shadow`) is free.
 *
 * The breadcrumb (`breadcrumbSegments`) shows the real nested path: a leaf
 * portal is `world → <name>`, unchanged; a membrane portal is
 * `world → <team> → <council-room>`; a portal opened from within an open
 * membrane portal nests under it.
 *
 * Multiple portals can be open at once (`openPortals`, a stack, not a
 * single selection) — `stackIndex` offsets this instance so they don't
 * overlap, and closing one (`closePortal`) never touches the others or the
 * map/chat `selection`.
 */
export function StorylinePortal({ elementRef, stackIndex = 0 }: { elementRef: ElementRef; stackIndex?: number }) {
  const { timeline, cursor, highlightedEventIds, openPortals } = useTimelineStore();
  const rows = useMemo(() => (timeline ? eventsForElement(timeline, elementRef) : []), [timeline, elementRef]);

  if (!timeline) return null;

  const membrane = membraneForRef(timeline, elementRef);
  const representedMembrane = membrane ? undefined : membraneForRepresentative(timeline, elementRef);
  const breadcrumb = breadcrumbSegments(timeline, openPortals, elementRef).join(" → ");

  return (
    <aside
      aria-label={`${labelFor(elementRef)} storyline`}
      className="storyline-portal"
      style={{ right: 16 + stackIndex * PORTAL_STACK_WIDTH }}
    >
      <div className="storyline-header">
        <span className="storyline-title">{membrane ? membrane.label : labelFor(elementRef)}</span>
        {!membrane ? <span className="storyline-count">{rows.length} events</span> : null}
        <button aria-label="Close storyline portal" onClick={() => closePortal(elementRef)} type="button">×</button>
      </div>
      <div className="storyline-breadcrumb">{breadcrumb}</div>
      {membrane ? (
        <MembraneView membrane={membrane} timeline={timeline} />
      ) : (
        <>
          {representedMembrane ? (
            <>
              <span className="boundary-badge" style={{ margin: "6px 10px 0", alignSelf: "flex-start" }}>
                boundary · represents {representedMembrane.label}
              </span>
              <button
                className="descend-button"
                onClick={() => focusAndOpenPortal(representedMembrane.ref)}
                type="button"
              >
                ⤵ descend into {representedMembrane.label}
              </button>
            </>
          ) : null}
          <StorylineRows cursor={cursor} highlightedEventIds={highlightedEventIds} rows={rows} timeline={timeline} />
        </>
      )}
    </aside>
  );
}
