import {
  asRecord,
  type ActionFeedRow,
  type UnknownRecord,
} from "./actionFeed.js";

export type ActionDecider = "declared" | "derived" | "refused";

export interface ActionDeciderPresentation {
  readonly decider: ActionDecider;
  readonly glyph: string;
  readonly word: string;
  readonly className: string;
}

export interface ActionSourceRecord {
  readonly provenance?: string;
  readonly live_acceptance?: boolean;
}

export interface ActionLivePresentation {
  readonly className: string;
  readonly isLive: boolean;
  readonly token: string;
}

/**
 * Classify the voice stated by the record. A viewer that switches on a verb
 * name has learned the scenario, so action names never participate here.
 */
export const actionDecider = (row: ActionFeedRow): ActionDecider => {
  if (row.outcome === "rejected") return "refused";
  if (row.provenance === "mechanical") return "derived";
  if (row.provenance !== undefined) return "declared";
  // Compatibility fallback only for older records that state no provenance.
  return row.phase === "commitment" ? "derived" : "declared";
};

const deciderPresentations: Record<ActionDecider, ActionDeciderPresentation> = {
  declared: {
    className: "feed-role-declared",
    decider: "declared",
    glyph: ">",
    word: "declared",
  },
  derived: {
    className: "feed-role-derived",
    decider: "derived",
    glyph: "=",
    word: "derived",
  },
  refused: {
    className: "feed-role-refused",
    decider: "refused",
    glyph: "x",
    word: "refused",
  },
};

export const actionDeciderPresentation = (
  decider: ActionDecider,
): ActionDeciderPresentation => deciderPresentations[decider];

/** Model-origin is an independent record axis and never changes the role hue. */
export const actionLivePresentation = (
  row: ActionFeedRow,
  source?: ActionSourceRecord,
): ActionLivePresentation => {
  const isLive = actionDecider(row) === "declared"
    && (source?.provenance === "agentic" || source?.live_acceptance === true);
  return {
    className: isLive ? "feed-role-live" : "",
    isLive,
    token: isLive ? " live" : "",
  };
};

export interface ActionFact {
  readonly label: string;
  readonly value: string;
}

/** A structural display label that preserves the full address elsewhere. */
export const displayName = (address: string): string => {
  const separator = Math.max(address.lastIndexOf(":"), address.lastIndexOf("."));
  return separator < 0 ? address : address.slice(separator + 1);
};

const coordinateFormatter = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 2,
  useGrouping: false,
});

const pointValue = (record: UnknownRecord): string | undefined => {
  const keys = Object.keys(record);
  if (keys.length !== 2 || !keys.includes("x") || !keys.includes("y")) {
    return undefined;
  }
  const { x, y } = record;
  if (typeof x !== "number" || !Number.isFinite(x)
    || typeof y !== "number" || !Number.isFinite(y)) return undefined;
  const coordinate = (value: number): string =>
    coordinateFormatter.format(Object.is(value, -0) ? 0 : value);
  return `(${coordinate(x)}, ${coordinate(y)})`;
};

const scalarValue = (value: unknown): string | undefined => {
  if (typeof value === "string" || typeof value === "boolean") {
    return String(value);
  }
  return typeof value === "number" && Number.isFinite(value)
    ? String(value)
    : undefined;
};

const labelSegment = (key: string): string => key.replaceAll("_", " ");

/**
 * Renderable facts stated by an action declaration's own input. Traversal is
 * depth-first in insertion order; unsupported values are omitted.
 */
export const declarationFacts = (input: unknown): readonly ActionFact[] => {
  const root = asRecord(input);
  if (root === undefined) return [];
  const facts: ActionFact[] = [];
  const visited = new WeakSet<object>();

  const visit = (record: UnknownRecord, path: readonly string[]): void => {
    if (visited.has(record)) return;
    visited.add(record);
    for (const [key, value] of Object.entries(record)) {
      const nextPath = [...path, labelSegment(key)];
      const scalar = scalarValue(value);
      if (scalar !== undefined) {
        facts.push({ label: nextPath.join("."), value: scalar });
        continue;
      }
      const nested = asRecord(value);
      if (nested === undefined) continue;
      const point = pointValue(nested);
      if (point !== undefined) {
        facts.push({ label: nextPath.join("."), value: point });
      } else {
        visit(nested, nextPath);
      }
    }
  };

  visit(root, []);
  return facts;
};
