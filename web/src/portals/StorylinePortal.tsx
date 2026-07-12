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
import { VariableSparkline, type RunMetaVariableSample } from "../viewer/RunMetaPanels.js";
import { sampleAtTick, trajectoryUpToTick } from "../viewer/variableModel.js";
import { MembraneView } from "./MembraneView.js";
import { StorylineRows } from "./StorylineRows.js";

const variableIdFromRef = (ref: ElementRef): string | undefined => ref.match(/^variable:(.+)$/u)?.[1];

/**
 * The `variable:<id>` storyline's own trajectory panel (increment 4):
 * renders ABOVE the shared `StorylineRows` strip, which already carries
 * this variable's "caused" events (the threshold rule firing, the resulting
 * `world.message`) via `eventsForElement`'s ordinary subject-membership
 * join — `buildWorldRecord`'s `variable:<id>` subjects
 * (`src/view/runTimelineRecords.ts`) put them there, no special-casing
 * needed in this component beyond the trajectory itself. The samples
 * themselves are RECORDS from `world/telemetry.json`, never
 * `TimelineEvent`s, so they render here rather than through
 * `StorylineRows`. Renders nothing (not even the panel) when this run has
 * no non-empty variable samples for this id — graceful absence, matching
 * `VariableGaugeRail`'s own gate.
 */
function VariableTrajectoryPanel({
  variableId,
  samples,
  tick,
}: {
  variableId: string;
  samples: readonly RunMetaVariableSample[] | undefined;
  tick: number | undefined;
}) {
  const asOf = sampleAtTick(samples, tick);
  const trajectory = trajectoryUpToTick(samples, variableId, tick);
  if (!asOf || asOf.variables[variableId] === undefined) return null;

  const history = (samples ?? [])
    .filter((sample) => tick === undefined || sample.tick <= tick)
    .filter((sample) => sample.variables[variableId] !== undefined)
    .sort((left, right) => left.tick - right.tick);

  return (
    <div className="variable-trajectory">
      <div className="variable-trajectory-head">
        <span className="variable-gauge-value">{asOf.variables[variableId]!.toFixed(2)}</span>
        <VariableSparkline values={trajectory} />
      </div>
      <ol className="variable-trajectory-list">
        {history.map((sample) => (
          <li key={sample.tick}>
            <span className="storyline-t">tick={sample.tick}</span>
            <span>{sample.variables[variableId]!.toFixed(3)}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}

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
export function StorylinePortal({
  elementRef,
  stackIndex = 0,
  variableSamples,
  variableTick,
}: {
  elementRef: ElementRef;
  stackIndex?: number;
  /** Increment 4: `/api/run-meta`'s `variableSamples`, passed down only so a `variable:<id>` portal can render its trajectory panel — `undefined`/absent for every other element kind's portal. */
  variableSamples?: readonly RunMetaVariableSample[];
  /** The world clock's own tick "as of" the scrub cursor (`variableModel.ts`'s `tickAtCursor`, computed once by `RunReplayShell`). */
  variableTick?: number;
}) {
  const { timeline, cursor, highlightedEventIds, openPortals } = useTimelineStore();
  const rows = useMemo(() => (timeline ? eventsForElement(timeline, elementRef) : []), [timeline, elementRef]);

  if (!timeline) return null;

  const membrane = membraneForRef(timeline, elementRef);
  const representedMembrane = membrane ? undefined : membraneForRepresentative(timeline, elementRef);
  const breadcrumb = breadcrumbSegments(timeline, openPortals, elementRef).join(" → ");
  const variableId = membrane ? undefined : variableIdFromRef(elementRef);

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
          {variableId ? (
            <VariableTrajectoryPanel samples={variableSamples} tick={variableTick} variableId={variableId} />
          ) : null}
          <StorylineRows cursor={cursor} highlightedEventIds={highlightedEventIds} rows={rows} timeline={timeline} />
        </>
      )}
    </aside>
  );
}
