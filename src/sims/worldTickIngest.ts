import type { LedgerEvent } from "../ledger/markers.js";
import type { MoltnetRoomMessage } from "../moltnet/types.js";

/**
 * Lowers one Moltnet room message to the `LedgerEvent` shape `scanMarkers`
 * (`../ledger/markers.ts`) expects, so the live world-driven loop can scan
 * real agent utterances for marker tokens exactly like the batch
 * `runSimfileTrace` scans its own minted events. `kind` here
 * ("moltnet.message") is a display-only label for this ingestion path — it
 * is never merged into `SimfileEventKind`'s own kind space and never minted
 * as a world-ledger event itself; only the `marker.seen` event a hit
 * produces gets written to `raw/world/causal.jsonl`.
 */
export const moltnetMessageToLedgerEvent = (
  message: MoltnetRoomMessage,
  roomScope: string,
  simTime: number
): LedgerEvent => ({
  event_id: message.id,
  kind: "moltnet.message",
  sim_time: simTime,
  actor: message.from.id,
  target: roomScope,
  scope: roomScope,
  payload: { content: (message.parts ?? []).map((part) => part.text ?? "").join(" ") }
});

export interface IngestNewRoomMessagesResult {
  newMessages: MoltnetRoomMessage[];
  ingestedIds: string[];
}

/**
 * Fetches the room's current message list and returns only the messages not
 * already present in `cursor` (mutated in place: registering an id here is
 * the ingestion cursor for the whole live loop — a message is folded into
 * exactly one tick, never re-scanned on a later poll). This is the ONLY read
 * the live loop performs against Moltnet each tick; delivery of world-minted
 * events is a separate write path (`../moltnet/world-participant.ts`).
 */
export const ingestNewRoomMessages = async (
  baseUrl: string,
  roomId: string,
  cursor: Set<string>,
  listMessages: (baseUrl: string, roomId: string, limit: number) => Promise<MoltnetRoomMessage[]>
): Promise<IngestNewRoomMessagesResult> => {
  const messages = await listMessages(baseUrl, roomId, 200);
  const newMessages = messages.filter((message) => !cursor.has(message.id));
  for (const message of newMessages) {
    cursor.add(message.id);
  }
  return { newMessages, ingestedIds: newMessages.map((message) => message.id) };
};
