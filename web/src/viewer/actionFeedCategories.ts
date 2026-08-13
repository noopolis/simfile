import type { ActionFeedRow } from "./actionFeed.js";
import {
  actionDecider,
  actionDeciderPresentation,
  type ActionDecider,
} from "./actionNarration.js";
import type { ActionLog, ActionLogEntry } from "./actionLog.js";

export interface ActionFeedCategory {
  readonly decider: ActionDecider;
  readonly key: string;
  readonly label: string;
  readonly verb: string;
}

const compareText = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const humanizeVerb = (verb: string): string =>
  verb.replaceAll(/[_-]/gu, " ");

export const actionFeedCategoryKey = (entry: ActionFeedRow): string =>
  `${actionDecider(entry)}|${entry.verb}`;

/** Derive the stable toggle set from the whole recorded log, never the cursor. */
export const actionFeedCategories = (
  log: ActionLog,
): readonly ActionFeedCategory[] => {
  const categories = new Map<string, ActionFeedCategory>();
  for (const entry of log.entries) {
    const key = actionFeedCategoryKey(entry);
    if (categories.has(key)) continue;
    const decider = actionDecider(entry);
    const word = actionDeciderPresentation(decider).word;
    categories.set(key, {
      decider,
      key,
      label: `${word} ${humanizeVerb(entry.verb)}`,
      verb: entry.verb,
    });
  }
  return [...categories.values()].sort((left, right) =>
    compareText(left.label, right.label) || compareText(left.key, right.key));
};

/** Count only the recorded prefix at or before the current cursor. */
export const actionFeedCategoryCounts = (
  entries: readonly ActionLogEntry[],
): ReadonlyMap<string, number> => {
  const counts = new Map<string, number>();
  for (const entry of entries) {
    const key = actionFeedCategoryKey(entry);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
};

export const filterActionFeedEntries = (
  entries: readonly ActionLogEntry[],
  hiddenKeys: ReadonlySet<string>,
): readonly ActionLogEntry[] => hiddenKeys.size === 0
  ? entries
  : entries.filter((entry) => !hiddenKeys.has(actionFeedCategoryKey(entry)));
