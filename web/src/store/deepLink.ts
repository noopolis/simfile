import {
  setCursor,
  setOpenPortals,
  setSelection,
  timelineStore,
  type ElementRef,
  type RunTimeline,
  type TimelineStoreState,
} from "./timeline.js";

/**
 * Deep links (`VIEW_DESIGN.md`: "a view is a value" + increment 2 rule 4):
 * `?at=<event_id>&sel=<elementRef>&portals=<comma-refs>` serializes cursor,
 * selection, and the open-portal stack into the URL, and restores them on
 * load. Anchored on `event_id` rather than the dense index `t`, because `t`
 * is only stable within one `buildRunTimeline` run — a fixture's causal
 * order can shift between re-derivations while the events themselves (and
 * their ids) do not, so a pasted link still finds "the same moment" after a
 * re-export.
 *
 * Pure parse/serialize/derive functions here are unit-testable without a
 * DOM or a running SPA; only `startDeepLinkSync` touches
 * `window.history`/`window.location`.
 */
export interface DeepLinkParams {
  at?: string;
  sel?: string;
  portals: ElementRef[];
}

const parsePortals = (raw: string | null): ElementRef[] =>
  raw ? raw.split(",").map((ref) => ref.trim()).filter((ref) => ref.length > 0) : [];

/** Parses a `location.search`-shaped string (with or without the leading `?`) into deep-link params. */
export const parseDeepLink = (search: string): DeepLinkParams => {
  const params = new URLSearchParams(search.startsWith("?") ? search : `?${search}`);
  const at = params.get("at");
  const sel = params.get("sel");
  return {
    at: at ?? undefined,
    sel: sel ?? undefined,
    portals: parsePortals(params.get("portals")),
  };
};

/** Serializes deep-link params into a `?...` query string (empty string when there is nothing to encode). */
export const serializeDeepLink = (params: DeepLinkParams): string => {
  const usp = new URLSearchParams();
  if (params.at) usp.set("at", params.at);
  if (params.sel) usp.set("sel", params.sel);
  if (params.portals.length > 0) usp.set("portals", params.portals.join(","));
  const query = usp.toString();
  return query ? `?${query}` : "";
};

/** Reads the deep-link value of the store's current cursor/selection/open-portal state. */
export const currentDeepLink = (state: Pick<TimelineStoreState, "timeline" | "cursor" | "selection" | "openPortals">): DeepLinkParams => ({
  at: state.timeline?.events[state.cursor]?.eventId,
  sel: state.selection ?? undefined,
  portals: state.openPortals,
});

/**
 * Applies parsed deep-link params to the store: `at` resolves to the event's
 * *current* `t` (never the serialized index), `sel` becomes the selection,
 * `portals` replaces the open-portal set. Missing/unresolvable ids are
 * ignored rather than throwing — a stale or hand-edited link degrades to
 * "just the parts that still resolve," never a crash.
 */
export const applyDeepLink = (timeline: RunTimeline, params: DeepLinkParams): void => {
  if (params.at) {
    const event = timeline.events.find((candidate) => candidate.eventId === params.at);
    if (event) setCursor(event.t);
  }
  if (params.sel) setSelection(params.sel);
  if (params.portals.length > 0) setOpenPortals(params.portals);
};

const THROTTLE_MS = 250;

/**
 * Subscribes to the timeline store and mirrors its deep-linkable fields into
 * the URL via `history.replaceState` (never `pushState` — scrubbing must not
 * spam browser history), throttled so a scrub drag or held playback does not
 * call `replaceState` on every frame. Returns an unsubscribe function.
 */
export const startDeepLinkSync = (): (() => void) => {
  let pending: ReturnType<typeof setTimeout> | null = null;

  const flush = (): void => {
    pending = null;
    const query = serializeDeepLink(currentDeepLink(timelineStore.getSnapshot()));
    const url = `${window.location.pathname}${query}${window.location.hash}`;
    window.history.replaceState(null, "", url);
  };

  const unsubscribe = timelineStore.subscribe(() => {
    if (pending !== null) return;
    pending = setTimeout(flush, THROTTLE_MS);
  });

  return () => {
    unsubscribe();
    if (pending !== null) clearTimeout(pending);
  };
};
