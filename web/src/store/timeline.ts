import { useSyncExternalStore } from "react";

/**
 * The one clock every time-linked view subscribes to (`VIEW_DESIGN.md` rule
 * 7: time is one axis everywhere, and the map, chat, minds rail, and agent
 * storyline portal must all rewind together, never keep private clocks).
 * This module is a plain external store (no Context, no per-tree instance)
 * so `ScrubBar`, `RunReplayShell`, and `StorylinePortal` all read and move
 * the exact same cursor.
 *
 * The shapes below mirror `src/view/runTimelineTypes.ts`'s `RunTimeline` /
 * `TimelineEvent` — a structural duplicate of the `/api/timeline` JSON
 * contract, not a cross-package import (this repo's web/src never imports
 * from src/; see `runWorldTrace.ts`'s equivalent note on the server side).
 */

export type ElementRef = string;

/** `clock`/`marker` (world's `clock.sync`/`marker.seen`) and `wake` shared with `control.wake.accepted` are increment 3's world-stream additions — see `src/view/runTimelineTypes.ts`'s equivalent doc comment. */
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
  t: number;
  eventId: string;
  authority: string;
  streamId: string;
  seq: number;
  type: string;
  viewClass: TimelineViewClass;
  recordedAt: string;
  actor?: string;
  subjects: ElementRef[];
  causes: string[];
  text?: string;
  /** Increment 3 dedup join: set on a `moltnet` message echo to the real `world`-authority event id it echoes — see `src/view/runTimelineTypes.ts`'s equivalent field doc. */
  worldEventId?: string;
  payload: unknown;
}

export type RunTimelineElementKind = "agent" | "room" | "bank" | "team";

export interface RunTimelineElement {
  ref: ElementRef;
  kind: RunTimelineElementKind;
  label: string;
}

export interface RunTimeline {
  version: string;
  runId: string;
  events: TimelineEvent[];
  elements: RunTimelineElement[];
  membranes?: Array<{
    ref: string;
    label: string;
    representative: string;
    interiorRooms: string[];
    members: string[];
  }>;
}

export interface TimelineStoreState {
  timeline: RunTimeline | null;
  /** The dense scrub key `0..events.length-1` every time-linked view reads as-of. */
  cursor: number;
  playing: boolean;
  /** Steps per second while `playing`. */
  speed: number;
  /** The current map/chat focus — independent of which portals are open. */
  selection: ElementRef | null;
  /**
   * Every currently open storyline portal, in open order. Portals stack
   * (`VIEW_DESIGN.md`: "Portals stack with breadcrumbs") — opening a bank
   * portal never closes an already-open agent portal, and vice versa. One
   * mechanism for every element kind (`agent:` | `room:` | `bank:`): there is
   * no per-kind portal list.
   */
  openPortals: ElementRef[];
  /**
   * Event ids currently linked-highlighted (recall -> turn linked selection,
   * increment 2 rule 2). Hovering or selecting a recall chip on a turn sets
   * this to the `memory.recalled` event id(s) it names; any open bank/agent
   * portal renders a matching row highlighted, cross-portal, through this
   * shared store field rather than component-to-component messaging.
   */
  highlightedEventIds: string[];
  loadError: string | null;
}

const listeners = new Set<() => void>();

const initialState = (): TimelineStoreState => ({
  timeline: null,
  cursor: 0,
  playing: false,
  speed: 2,
  selection: null,
  openPortals: [],
  highlightedEventIds: [],
  loadError: null,
});

let state: TimelineStoreState = initialState();

const emit = (): void => {
  for (const listener of listeners) listener();
};

const setState = (patch: Partial<TimelineStoreState>): void => {
  state = { ...state, ...patch };
  emit();
};

export const timelineStore = {
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  getSnapshot(): TimelineStoreState {
    return state;
  },
};

/** Reset hook for tests: this module holds process-wide singleton state. */
export const resetTimelineStoreForTests = (): void => {
  state = initialState();
};

export const maxCursor = (timeline: RunTimeline | null): number =>
  timeline ? Math.max(0, timeline.events.length - 1) : 0;

export const loadTimeline = (timeline: RunTimeline): void => {
  setState({ timeline, cursor: 0, loadError: null });
};

export const setLoadError = (message: string): void => setState({ loadError: message });

export const setCursor = (t: number): void => {
  const max = maxCursor(state.timeline);
  const clamped = Math.max(0, Math.min(max, Math.round(t)));
  setState({ cursor: clamped });
};

export const stepBy = (delta: number): void => setCursor(state.cursor + delta);
export const jumpStart = (): void => setCursor(0);
export const jumpEnd = (): void => setCursor(maxCursor(state.timeline));

export const play = (): void => setState({ playing: true });
export const pause = (): void => setState({ playing: false });
export const togglePlay = (): void => setState({ playing: !state.playing });
export const setSpeed = (speed: number): void => setState({ speed: Math.max(0.25, speed) });

export const setSelection = (ref: ElementRef | null): void => setState({ selection: ref });

/** Opens `ref`'s storyline portal if it is not already open. Idempotent. */
export const openPortal = (ref: ElementRef): void => {
  if (state.openPortals.includes(ref)) return;
  setState({ openPortals: [...state.openPortals, ref] });
};

export const closePortal = (ref: ElementRef): void =>
  setState({ openPortals: state.openPortals.filter((open) => open !== ref) });

/** Deep-link restore: replaces the whole open-portal set in one write. */
export const setOpenPortals = (refs: readonly ElementRef[]): void =>
  setState({ openPortals: [...new Set(refs)] });

/**
 * The one open-trigger every element kind shares (increment 2 rule 1: "one
 * mechanism, all element kinds — no per-kind portal code"). Focuses `ref` as
 * the current map/chat selection and opens its storyline portal, whether
 * `ref` is `agent:`, `room:`, or `bank:`.
 */
export const focusAndOpenPortal = (ref: ElementRef): void => {
  setSelection(ref);
  openPortal(ref);
};

export const setHighlightedEventIds = (ids: readonly string[]): void =>
  setState({ highlightedEventIds: [...ids] });

export const clearHighlightedEventIds = (): void => setState({ highlightedEventIds: [] });

/**
 * The time-link invariant, as a value every consumer shares instead of
 * re-deriving: the prefix slice of events "as of" a cursor. Because
 * `TimelineEvent.t` is assigned densely in final order (`runTimeline.ts`),
 * this is equivalent to `timeline.events.slice(0, cursor + 1)`, but filters
 * defensively on `t` so it can never return an event with `t > cursor` even
 * if a caller passes an unsorted or filtered event list.
 */
export const eventsUpTo = (timeline: RunTimeline, cursor: number): TimelineEvent[] =>
  timeline.events.filter((event) => event.t <= cursor);

/**
 * Every event whose `subjects` includes `ref`, in `t` order — the raw feed a
 * storyline portal renders, whatever kind of element `ref` names (`agent:` |
 * `room:` | `bank:`). One slice function for every portal kind: a room
 * storyline is `eventsForElement(timeline, "room:...")`, a bank storyline is
 * `eventsForElement(timeline, "bank:...")`, unchanged from the agent case.
 */
export const eventsForElement = (timeline: RunTimeline, ref: ElementRef): TimelineEvent[] =>
  timeline.events.filter((event) => event.subjects.includes(ref));

/**
 * The combined storyline inside a membrane. An event may name both an
 * interior room and a member, so union by event id before restoring the
 * timeline's ascending `t` order.
 */
export const eventsForMembrane = (timeline: RunTimeline, membraneRef: ElementRef): TimelineEvent[] => {
  const membrane = timeline.membranes?.find(({ ref }) => ref === membraneRef);
  if (!membrane) return [];

  const eventsById = new Map<string, TimelineEvent>();
  for (const ref of [...membrane.interiorRooms, ...membrane.members]) {
    for (const event of eventsForElement(timeline, ref)) {
      if (!eventsById.has(event.eventId)) eventsById.set(event.eventId, event);
    }
  }

  return [...eventsById.values()].sort((left, right) => left.t - right.t);
};

/**
 * Recall -> turn linked selection (increment 2 rule 2): a `turn.input` event
 * whose own `causes` include `mneme:`-prefixed ids means "this memory fed
 * this turn." Resolves those cause ids, by id (never by ordinal position),
 * to the actual `memory.recalled` `TimelineEvent` rows already in the
 * timeline, so a recall chip can point at (and highlight) the exact bank-log
 * row it names. Ids with no matching event (outside this run's recorded set)
 * are silently dropped rather than invented.
 */
export const recallEventsForTurnInput = (timeline: RunTimeline, turnInput: TimelineEvent): TimelineEvent[] => {
  const byEventId = new Map(timeline.events.map((event) => [event.eventId, event] as const));
  return turnInput.causes
    .filter((causeId) => causeId.startsWith("mneme:"))
    .map((causeId) => byEventId.get(causeId))
    .filter((event): event is TimelineEvent => event !== undefined);
};

/**
 * Increment 3 dedup rule: the set of `world`-authority event ids that have
 * a moltnet echo (a `message` event whose `worldEventId` names them) —
 * every id in this set is a `world.message` the chat pane must suppress
 * (its moltnet twin, badged "world", already renders it); every
 * `world`-authority message NOT in this set has no echo and renders
 * standalone, flagged "not delivered". Computed over the whole timeline
 * (never cursor-sliced) because the echo relationship is structural, not
 * time-dependent.
 */
export const echoedWorldEventIds = (events: readonly TimelineEvent[]): ReadonlySet<string> => {
  const echoed = new Set<string>();
  for (const event of events) {
    if (event.authority === "moltnet" && event.worldEventId) echoed.add(event.worldEventId);
  }
  return echoed;
};

export const useTimelineStore = (): TimelineStoreState =>
  useSyncExternalStore(timelineStore.subscribe, timelineStore.getSnapshot, timelineStore.getSnapshot);
