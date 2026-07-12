import path from "node:path";

import type { RawTranscriptMessage } from "./runViewModelTypes.js";
import type { ElementRef } from "./runTimelineTypes.js";

/**
 * The small, generic `ElementRef`/string helpers `runTimeline.ts` (the
 * orchestrator) and `runTimelineRecords.ts` (the per-authority record
 * builders) both need — split out so neither file has to import the other
 * just for a one-line ref constructor (`AGENTS.md`: small composable
 * modules, split before 400 lines).
 */

export const agentRef = (id: string): ElementRef => `agent:${id}`;
export const roomRef = (network: string, room: string): ElementRef => `room:${network}:${room}`;
export const bankRef = (bank: string): ElementRef => `bank:${bank}`;

/** Inverse of `roomRef`: splits a `room:<network>:<room>` ref back into its parts. `undefined` for anything else. */
export const parseRoomRef = (ref: ElementRef): { networkId: string; roomId: string } | undefined => {
  const match = ref.match(/^room:([^:]+):(.+)$/u);
  return match ? { networkId: match[1]!, roomId: match[2]! } : undefined;
};

/** Strips a ref's `<kind>:` prefix, e.g. `agent:luna-shadow` -> `luna-shadow`. Refs with no `:` pass through unchanged. */
export const stripRefPrefix = (ref: ElementRef): string => (ref.includes(":") ? ref.slice(ref.indexOf(":") + 1) : ref);

export const isDefined = <T,>(value: T | undefined): value is T => value !== undefined;

export const stringField = (record: Record<string, unknown> | undefined, key: string): string | undefined => {
  const value = record?.[key];
  return typeof value === "string" ? value : undefined;
};

export const messageText = (message: RawTranscriptMessage): string =>
  message.parts.find((part) => part.kind === "text")?.text ?? "";

export const agentIdFromStreamId = (streamId: string): string | undefined => streamId.match(/^agent:(.+)$/u)?.[1];

export const networkIdFromStreamId = (streamId: string): string | undefined => streamId.match(/^network:(.+)$/u)?.[1];

export const bankFromRelativePath = (relativePath: string): string | undefined => {
  const segments = relativePath.split(path.sep);
  return segments[0] === "raw" && segments[1] === "mneme" ? segments[2] : undefined;
};
