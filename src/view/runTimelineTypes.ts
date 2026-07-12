/**
 * `RunTimeline` — the single merged, dense, causally-repaired event
 * timeline `simfile view <run-dir>`'s run-replay mode scrubs (`VIEW_DESIGN.md`
 * rule 7: time is one axis everywhere). Built once per run by
 * `buildRunTimeline` (`runTimeline.ts`) from every `causal.jsonl` stream
 * (`../observe/causalStreams.ts`'s `collectCausalStreams`) plus every mneme
 * bank's `events.jsonl` bank log. `t` is the scrub key: a dense integer
 * `0..N-1` assigned after sorting and causal repair, never `recorded_at`
 * directly (real clocks are not guaranteed monotonic across systems).
 */

/**
 * `agent:<id>` | `room:<network>:<room>` | `bank:<bank>`. Reserved for a
 * later increment: `variable:` and `object:` (no data to back them yet).
 */
export type ElementRef = string;

export type TimelineViewClass =
  | "message"
  | "wake"
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
  payload: unknown;
}

export type RunTimelineElementKind = "agent" | "room" | "bank";

export interface RunTimelineElement {
  ref: ElementRef;
  kind: RunTimelineElementKind;
  label: string;
}

export interface RunTimeline {
  version: "simfile.run-timeline.v1";
  runId: string;
  events: TimelineEvent[];
  elements: RunTimelineElement[];
}
