import type { RunWorldTrace } from "./runWorldTrace.js";

/**
 * `RunTimeline` — the single merged, dense, causally-repaired event
 * timeline `simfile view <run-dir>`'s run-replay mode scrubs (`docs/VIEW_DESIGN.md`
 * rule 7: time is one axis everywhere). Built once per run by
 * `buildRunTimeline` (`runTimeline.ts`) from every `causal.jsonl` stream
 * (`../observe/causalStreams.ts`'s `collectCausalStreams`) plus every mneme
 * bank's `events.jsonl` bank log. `t` is the scrub key: a dense integer
 * `0..N-1` assigned after sorting and causal repair, never `recorded_at`
 * directly (real clocks are not guaranteed monotonic across systems).
 */

/**
 * `agent:<id>` | `room:<network>:<room>` | `bank:<bank>` | `variable:<id>`
 * (increment 4's variable storyline). `object:` remains reserved — no data
 * to back it yet.
 */
export type ElementRef = string;

/**
 * `clock` (`clock.sync`) and `marker` (`marker.seen`) are increment 3's
 * world-authority additions (`buildWorldRecord` in `runTimeline.ts`);
 * `wake` represents Daimon's accepted control wake.
 */
export type TimelineViewClass =
  | "message"
  | "wake"
  | "clock"
  | "marker"
  | "turn.input"
  | "turn.output"
  | "memory.claimed"
  | "memory.observed"
  | "memory.recalled"
  | "other";

export interface TimelineEvent {
  /** Dense scrub key, 0..N-1, assigned after sort + causal repair. */
  t: number;
  /** The real record id: a `causal.jsonl` `event_id` or a mneme bank log row's `id`. */
  eventId: string;
  /** The `raw/<authority>/...` directory this record was read from (`moltnet` | `daimon` | `mneme`). */
  authority: string;
  streamId: string;
  seq: number;
  type: string;
  viewClass: TimelineViewClass;
  /** The record's own timestamp — a display annotation; `t` is the scrub axis. */
  recordedAt: string;
  actor?: string;
  /** Every element whose storyline includes this event. */
  subjects: ElementRef[];
  /** This record's own causal predecessor ids, verbatim (never invented). */
  causes: string[];
  /** Joined from the transcript or a mneme bank log by id — never invented. */
  text?: string;
  /**
   * Increment 3 dedup join: on a `moltnet` `message.accepted` record, the
   * `simfile_event_id` breadcrumb read from the transcript message's own
   * `parts[].data` (`src/moltnet/world-participant.ts`'s
   * `metadataFromEvent`) — the real `world.message`/`world.dm` event this
   * message echoes, when this message
   * originated from a world action. Undefined for a message with no such
   * breadcrumb (a genuine agent-authored message). The chat pane uses this
   * to badge the echo "world" and to suppress its `world`-authority twin.
   */
  worldEventId?: string;
  payload: unknown;
}

export type RunTimelineElementKind = "agent" | "room" | "bank" | "team" | "variable";

export interface RunTimelineElement {
  ref: ElementRef;
  kind: RunTimelineElementKind;
  label: string;
}

/**
 * An interior self-team (the "descend into a mind" structure): a team that
 * owns its own Moltnet network (`interiorRooms`) and is represented on a
 * parent floor by one of its members (`representative`). Derived from the
 * run's `spawnfile-report.json` by `membranes.ts`'s `deriveMembranes`.
 */
export interface RunTimelineMembrane {
  /** `team:<id>`. */
  ref: string;
  label: string;
  /** `agent:<id>` of the team's parent-floor representative (its lead/external face). */
  representative: string;
  /** `room:<network>:<room>` refs for the team's own interior council room(s). */
  interiorRooms: string[];
  /** `agent:<id>` refs for every member of the interior room(s). */
  members: string[];
  /**
   * A `viewer.trace.v1` world trace scoped to exactly this membrane's
   * `interiorRooms` — the "descend into a mind" mini map (`runWorldTrace.ts`'s
   * `buildMembraneInteriorWorlds`, populated by `server.ts` once the full
   * `RunTimeline` exists; `deriveMembranes`/`buildRunTimeline` never set this
   * field themselves, since it needs the completed timeline). Undefined only
   * before that population step runs.
   */
  interiorWorld?: RunWorldTrace;
}

export interface RunTimeline {
  version: "simfile.run-timeline.v1";
  runId: string;
  events: TimelineEvent[];
  elements: RunTimelineElement[];
  membranes?: RunTimelineMembrane[];
}
