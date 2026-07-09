import { scanMarkers, type MarkerDefinition } from "../ledger/markers.js";
import { stableStringify } from "../ledger/stable.js";
import type { RuntimeTraceEvent } from "./types.js";

export const serializeCanonicalEvents = (events: readonly RuntimeTraceEvent[]): string[] =>
  events.map(stableStringify);

export const scanTraceMarkers = (
  events: readonly RuntimeTraceEvent[],
  markers: Record<string, MarkerDefinition>
): ReturnType<typeof scanMarkers> => scanMarkers(events, markers);
