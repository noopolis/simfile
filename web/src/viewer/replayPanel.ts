import { maxCursor, type ReplayPanel, type RunTimeline } from "../store/timeline.js";
import { participantChatMessages } from "./ChatPane.js";

/** Uses the exact admission rule of the visible chat, over the complete run. */
export const hasMeaningfulConversation = (timeline: RunTimeline): boolean =>
  participantChatMessages(timeline, maxCursor(timeline)).length > 0;

export const defaultReplayPanel = (timeline: RunTimeline): ReplayPanel =>
  hasMeaningfulConversation(timeline) ? "conversation" : "map";

/** Explicit URL, then an existing user choice, then evidence-derived default. */
export const initialReplayPanel = (
  timeline: RunTimeline,
  explicitPanel: ReplayPanel | undefined,
  existingPanel: ReplayPanel | null,
): ReplayPanel => explicitPanel ?? existingPanel ?? defaultReplayPanel(timeline);
