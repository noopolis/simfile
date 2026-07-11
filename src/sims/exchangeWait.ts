import { listMoltnetRoomMessages, type MoltnetRoomMessage } from "./moltnetRoomClient.js";

/**
 * Pure stop/continue decision + polling loop for a bounded multi-turn Moltnet
 * exchange, ported from `src/e2e/moltnetExchangeWait.ts` (Piece 5's design
 * calls that file out as "pure, scenario-agnostic" — the logic to reuse, not
 * a module to import: this package's charter forbids depending on Spawnfile
 * internals, so the decision function and polling loop are reproduced here
 * verbatim rather than referenced across the package boundary).
 *
 * Derail guard (Decision 21, Piece 5 design): this ONLY polls and decides
 * "done" — it never re-sends a mention or otherwise coaxes a reply. If a
 * real run never completes an exchange, that is a platform gap to FILE
 * against the owning layer (Phase B), never something this loop works around
 * by nudging the room again.
 */

export const MIN_TARGET_TURNS = 3;
export const DEFAULT_TARGET_TURNS = 3;
export const DEFAULT_QUIET_GRACE_MS = 35_000;

export type ExchangeEndReason = "turn-cap" | "quiet-timeout" | "timeout";

export const resolveTargetTurns = (targetTurns?: number): number =>
  Math.max(MIN_TARGET_TURNS, targetTurns ?? DEFAULT_TARGET_TURNS);

export interface ExchangeCompletionInput {
  agentTurnCount: number;
  elapsedSinceLastAgentMessageMs: number;
  elapsedSinceStartMs: number;
  quietGraceMs: number;
  targetTurns: number;
  timeoutMs: number;
}

export interface ExchangeCompletionResult {
  done: boolean;
  reason: ExchangeEndReason | null;
}

/** Same precedence as the ported original: turn-cap, then quiet-timeout
 * (only once at least one agent turn has landed), then the overall timeout. */
export const evaluateExchangeCompletion = (input: ExchangeCompletionInput): ExchangeCompletionResult => {
  if (input.agentTurnCount >= input.targetTurns) return { done: true, reason: "turn-cap" };
  if (input.agentTurnCount > 0 && input.elapsedSinceLastAgentMessageMs >= input.quietGraceMs) {
    return { done: true, reason: "quiet-timeout" };
  }
  if (input.elapsedSinceStartMs >= input.timeoutMs) return { done: true, reason: "timeout" };
  return { done: false, reason: null };
};

export interface WaitForConversationExchangeOptions {
  agentIds: readonly string[];
  intervalMs: number;
  /** Injectable for tests; defaults to a real `listMoltnetRoomMessages` GET. */
  listMessages?: (baseUrl: string, roomId: string, limit: number) => Promise<MoltnetRoomMessage[]>;
  now?: () => number;
  quietGraceMs: number;
  sleep: (delayMs: number) => Promise<void>;
  targetTurns: number;
  timeoutMs: number;
}

export interface ConversationExchangeResult {
  agentTurns: MoltnetRoomMessage[];
  endedReason: ExchangeEndReason;
  transcript: MoltnetRoomMessage[];
}

/** Only ever GETs the room's message list and re-evaluates
 * `evaluateExchangeCompletion` — poll-read-only, seed-once discipline. The
 * caller seeds the room exactly once, before calling this. */
export const waitForConversationExchange = async (
  baseUrl: string,
  roomId: string,
  baselineIds: ReadonlySet<string>,
  options: WaitForConversationExchangeOptions
): Promise<ConversationExchangeResult> => {
  const now = options.now ?? (() => Date.now());
  const listMessages = options.listMessages ?? listMoltnetRoomMessages;
  const startedAt = now();
  const seenIds = new Set(baselineIds);
  const agentTurns: MoltnetRoomMessage[] = [];
  let lastAgentMessageAt = startedAt;
  let transcript: MoltnetRoomMessage[] = [];

  for (;;) {
    transcript = await listMessages(baseUrl, roomId, 200);
    for (const message of transcript) {
      if (seenIds.has(message.id)) continue;
      seenIds.add(message.id);
      if (options.agentIds.includes(message.from.id)) {
        agentTurns.push(message);
        lastAgentMessageAt = now();
      }
    }

    const evaluation = evaluateExchangeCompletion({
      agentTurnCount: agentTurns.length,
      elapsedSinceLastAgentMessageMs: now() - lastAgentMessageAt,
      elapsedSinceStartMs: now() - startedAt,
      quietGraceMs: options.quietGraceMs,
      targetTurns: options.targetTurns,
      timeoutMs: options.timeoutMs
    });
    if (evaluation.done) return { agentTurns, endedReason: evaluation.reason as ExchangeEndReason, transcript };

    await options.sleep(options.intervalMs);
  }
};
