import type { RunTimeline } from "../store/timeline.js";

/**
 * Increment 3: pure joins between `/api/run-meta`'s `seedSpread`/
 * `spreadSummary` (a structural duplicate of `src/observe/report.ts`'s
 * `SeedSpreadEntry`/`SpreadSummary` — the same web/src-never-imports-src/
 * boundary every other store type in this app already follows) and the
 * loaded `RunTimeline`. Kept separate from `../store/timeline.ts` because
 * these types belong to the run-meta contract, not the timeline contract
 * — `echoedWorldEventIds` (the world/moltnet dedup join) stays in the
 * store module since it only ever needs `TimelineEvent` fields.
 *
 * No UI here: `ReplayPanes.tsx`'s `ChatPane` (seed badges), `RunMetaPanels.tsx`
 * (the spread readout), and `RunReplayShell.tsx` (the map glow) all call
 * these functions rather than re-deriving the joins inline.
 */

export type SeedSpreadChannel = "doc-seeded" | "uttered" | "registered" | "recalled";

export interface SeedSpreadEntry {
  channel: SeedSpreadChannel;
  event_id: string;
  fidelity?: number;
  agent?: string;
  tick?: number;
  memory_write_source?: string;
}

export interface SpreadFirstAppearance {
  agent: string;
  channel: SeedSpreadChannel;
  event_id: string;
  tick?: number;
}

export interface SpreadSummary {
  reach: number;
  latency?: number;
  first_appearance: SpreadFirstAppearance[];
}

/** Every `seed_spread` event id, whatever channel — the scrub bar's "spread dot" markers. */
export const seedSpreadEventIds = (seedSpread: readonly SeedSpreadEntry[] | undefined): ReadonlySet<string> =>
  new Set((seedSpread ?? []).map((entry) => entry.event_id));

/** Only the `uttered` channel's event ids — the chat pane's "🧬 seed" message badge. */
export const utteredEventIds = (seedSpread: readonly SeedSpreadEntry[] | undefined): ReadonlySet<string> =>
  new Set((seedSpread ?? []).filter((entry) => entry.channel === "uttered").map((entry) => entry.event_id));

/**
 * The map scopes (`agent:<id>` refs, plus `roomScope` when given) to glow
 * once the cursor has reached each `first_appearance` entry's own real
 * timeline event — joined by `event_id`, never by `tick` alone (a run can
 * skip ticks, and `t` is the only axis the map/cursor actually share).
 * Returns `[]` when there is no `spreadSummary` (graceful absence) or the
 * cursor hasn't reached any appearance yet.
 */
export const firstAppearanceGlowScopes = (params: {
  spreadSummary: SpreadSummary | undefined;
  timeline: RunTimeline;
  cursor: number;
  roomScope?: string;
}): string[] => {
  const { spreadSummary, timeline, cursor, roomScope } = params;
  if (!spreadSummary) return [];

  const byEventId = new Map(timeline.events.map((event) => [event.eventId, event] as const));
  const scopes = new Set<string>();
  for (const appearance of spreadSummary.first_appearance) {
    const event = byEventId.get(appearance.event_id);
    if (!event || event.t > cursor) continue;
    scopes.add(`agent:${appearance.agent}`);
    if (roomScope) scopes.add(roomScope);
  }
  return [...scopes];
};
