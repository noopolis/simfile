import React, { useEffect, useMemo, useRef, useState } from "react";

import type { RunTimeline } from "../store/timeline.js";
import { summarizeActions } from "./actionFeed.js";
import {
  actionFeedCategories,
  actionFeedCategoryCounts,
  filterActionFeedEntries,
} from "./actionFeedCategories.js";
import { ActionLogRow, StandingCommitmentRow } from "./ActionFeedRows.js";
import { actionLogUpToTick, buildActionLog } from "./actionLog.js";
import {
  commitmentSpanInForceAt,
  commitmentSpans,
} from "./commitmentSpans.js";

/**
 * The action feed is an append log: everything recorded up to the cursor,
 * oldest first, with standing commitments shown above it.
 */
export function ActionFeedPane({
  timeline,
  tick,
}: {
  timeline: RunTimeline;
  tick: number | undefined;
}) {
  // Built once per timeline: neither the log nor the spans move with the cursor.
  const log = useMemo(() => buildActionLog(timeline), [timeline]);
  const spans = useMemo(() => commitmentSpans(timeline), [timeline]);
  const entries = useMemo(() => actionLogUpToTick(log, tick), [log, tick]);
  const categories = useMemo(() => actionFeedCategories(log), [log]);
  const counts = useMemo(() => actionFeedCategoryCounts(entries), [entries]);
  const [hiddenKeys, setHiddenKeys] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  useEffect(() => setHiddenKeys(new Set()), [timeline]);
  const visibleEntries = useMemo(
    () => filterActionFeedEntries(entries, hiddenKeys),
    [entries, hiddenKeys],
  );
  const hiddenCount = entries.length - visibleEntries.length;
  const summary = useMemo(
    () => summarizeActions(visibleEntries),
    [visibleEntries],
  );
  const standing = useMemo(
    () => tick === undefined
      ? []
      : spans.filter((span) => commitmentSpanInForceAt(span, tick)),
    [spans, tick],
  );
  const open = standing.filter(({ resolution }) => resolution === undefined).length;

  // Newest is at the bottom, so the newest is what the observer must be looking at.
  const body = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const node = body.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [visibleEntries]);

  const setCategoryVisible = (key: string, visible: boolean): void => {
    setHiddenKeys((current) => {
      const next = new Set(current);
      if (visible) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  return (
    <section className="replay-pane replay-actions" aria-label="Action feed">
      <header className="replay-pane-header">
        {tick === undefined
          ? "actions · the run records no tick at this position · 0 hidden by filters"
          : `tick ${tick} · ${standing.length} commitments in force (${open} still standing) · ${entries.length} recorded through here · ${hiddenCount} hidden by filters`}
      </header>
      {categories.length === 0 ? null : (
        <div
          className="feed-filter-bar"
          aria-label="Action feed categories"
          role="group"
        >
          {categories.map((category) => {
            const count = counts.get(category.key) ?? 0;
            const empty = count === 0;
            return (
              <label
                className={`feed-filter-option${empty ? " feed-filter-option-empty" : ""}`}
                key={category.key}
              >
                <input
                  aria-disabled={empty ? true : undefined}
                  checked={!hiddenKeys.has(category.key)}
                  disabled={empty}
                  onChange={(event) =>
                    setCategoryVisible(category.key, event.currentTarget.checked)}
                  type="checkbox"
                />
                <span>{category.label}</span>
                <span className="feed-filter-count">
                  {empty ? "none yet" : count}
                </span>
              </label>
            );
          })}
        </div>
      )}
      <div className="replay-pane-body" ref={body}>
        {tick === undefined ? null : (
          <>
            {standing.length === 0 ? (
              <p className="feed-empty">
                no commitment is in force at this tick
              </p>
            ) : (
              standing.map((span) => (
                <StandingCommitmentRow
                  key={span.eventId}
                  span={span}
                  timeline={timeline}
                />
              ))
            )}
            {entries.length === 0 ? (
              <p className="feed-empty feed-log-separator">
                the run records nothing through this tick
              </p>
            ) : visibleEntries.length === 0 ? (
              <p className="feed-empty feed-log-separator">
                the filters hide all {entries.length} records through this tick
              </p>
            ) : (
              <>
                <p className="feed-empty feed-log-separator">
                  recorded through this tick · {summary.accepted} accepted ·{" "}
                  {summary.rejected} rejected · {summary.pending} pending ·{" "}
                  {summary.fulfilled} fulfilled · {summary.expired} expired ·{" "}
                  {summary.abandoned} abandoned · {summary.matched} matched ·{" "}
                  {summary.unmatched} unmatched
                </p>
                {visibleEntries.map((entry) => (
                  <ActionLogRow
                    entry={entry}
                    key={`${entry.eventId}:${entry.phase}`}
                    timeline={timeline}
                  />
                ))}
              </>
            )}
          </>
        )}
      </div>
    </section>
  );
}
