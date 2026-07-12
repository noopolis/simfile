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
