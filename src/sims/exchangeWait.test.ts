import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  DEFAULT_QUIET_GRACE_MS,
  DEFAULT_TARGET_TURNS,
  MIN_TARGET_TURNS,
  evaluateExchangeCompletion,
  resolveTargetTurns,
  waitForConversationExchange
} from "./exchangeWait.js";
import type { MoltnetRoomMessage } from "./moltnetRoomClient.js";

const createMessage = (id: string, authorId: string, text: string): MoltnetRoomMessage => ({
  from: { id: authorId },
  id,
  parts: [{ kind: "text", text }]
});

describe("resolveTargetTurns", () => {
  it("defaults to DEFAULT_TARGET_TURNS", () => {
    assert.equal(resolveTargetTurns(undefined), DEFAULT_TARGET_TURNS);
  });

  it("clamps below-minimum requests up to MIN_TARGET_TURNS", () => {
    assert.equal(resolveTargetTurns(1), MIN_TARGET_TURNS);
  });

  it("passes through values at or above the minimum", () => {
    assert.equal(resolveTargetTurns(6), 6);
  });
});

describe("evaluateExchangeCompletion", () => {
  it("stops on turn-cap once the target turn count is reached", () => {
    assert.deepEqual(
      evaluateExchangeCompletion({
        agentTurnCount: 3,
        elapsedSinceLastAgentMessageMs: 0,
        elapsedSinceStartMs: 1_000,
        quietGraceMs: DEFAULT_QUIET_GRACE_MS,
        targetTurns: 3,
        timeoutMs: 300_000
      }),
      { done: true, reason: "turn-cap" }
    );
  });

  it("does not stop on quiet-timeout before any agent turn has been observed", () => {
    assert.deepEqual(
      evaluateExchangeCompletion({
        agentTurnCount: 0,
        elapsedSinceLastAgentMessageMs: 999_999,
        elapsedSinceStartMs: 999_998,
        quietGraceMs: DEFAULT_QUIET_GRACE_MS,
        targetTurns: 3,
        timeoutMs: 1_000_000
      }),
      { done: false, reason: null }
    );
  });

  it("stops on quiet-timeout once the grace period elapses after the last agent turn, below the turn cap", () => {
    assert.deepEqual(
      evaluateExchangeCompletion({
        agentTurnCount: 2,
        elapsedSinceLastAgentMessageMs: 35_000,
        elapsedSinceStartMs: 60_000,
        quietGraceMs: 35_000,
        targetTurns: 4,
        timeoutMs: 300_000
      }),
      { done: true, reason: "quiet-timeout" }
    );
  });

  it("stops on the overall timeout even mid-quiet-period and below the turn cap", () => {
    assert.deepEqual(
      evaluateExchangeCompletion({
        agentTurnCount: 1,
        elapsedSinceLastAgentMessageMs: 5_000,
        elapsedSinceStartMs: 300_000,
        quietGraceMs: 35_000,
        targetTurns: 4,
        timeoutMs: 300_000
      }),
      { done: true, reason: "timeout" }
    );
  });

  it("prefers turn-cap over quiet-timeout when both conditions are met simultaneously", () => {
    assert.deepEqual(
      evaluateExchangeCompletion({
        agentTurnCount: 4,
        elapsedSinceLastAgentMessageMs: 40_000,
        elapsedSinceStartMs: 90_000,
        quietGraceMs: 35_000,
        targetTurns: 4,
        timeoutMs: 300_000
      }),
      { done: true, reason: "turn-cap" }
    );
  });
});

describe("waitForConversationExchange", () => {
  it("collects turns until the turn cap and returns the full transcript, never sending a second message", () => {
    const allMessages = [
      createMessage("seed", "operator", "seed"),
      createMessage("m1", "eleanor", "propose"),
      createMessage("m2", "sam", "accept"),
      createMessage("m3", "eleanor", "close")
    ];
    let call = 0;
    const listMessages = async () => {
      call += 1;
      return allMessages.slice(0, Math.min(1 + call, allMessages.length));
    };
    let clock = 0;

    return waitForConversationExchange(
      "http://127.0.0.1:1",
      "office-room",
      new Set(["seed"]),
      {
        agentIds: ["eleanor", "sam"],
        intervalMs: 5,
        listMessages,
        now: () => clock,
        quietGraceMs: 35_000,
        sleep: async () => {
          clock += 1_000;
        },
        targetTurns: 3,
        timeoutMs: 300_000
      }
    ).then((result) => {
      assert.equal(result.endedReason, "turn-cap");
      assert.deepEqual(result.agentTurns.map((message) => message.id), ["m1", "m2", "m3"]);
      assert.deepEqual(result.transcript, allMessages);
    });
  });

  it("concludes on quiet-timeout when no further agent turn arrives", async () => {
    const allMessages = [
      createMessage("seed", "operator", "seed"),
      createMessage("m1", "eleanor", "propose"),
      createMessage("m2", "sam", "agree, no further mention")
    ];
    let clock = 0;

    const result = await waitForConversationExchange(
      "http://127.0.0.1:1",
      "office-room",
      new Set(["seed"]),
      {
        agentIds: ["eleanor", "sam"],
        intervalMs: 1_000,
        listMessages: async () => allMessages,
        now: () => clock,
        quietGraceMs: 5_000,
        sleep: async () => {
          clock += 1_000;
        },
        targetTurns: 4,
        timeoutMs: 300_000
      }
    );

    assert.equal(result.endedReason, "quiet-timeout");
    assert.deepEqual(result.agentTurns.map((message) => message.id), ["m1", "m2"]);
  });

  it("ignores non-agent senders (e.g. the operator seed) when counting agent turns", async () => {
    const allMessages = [
      createMessage("seed", "operator", "seed"),
      createMessage("m1", "eleanor", "propose"),
      createMessage("m2", "sam", "accept"),
      createMessage("m3", "eleanor", "close")
    ];

    const result = await waitForConversationExchange(
      "http://127.0.0.1:1",
      "office-room",
      new Set(),
      {
        agentIds: ["eleanor", "sam"],
        intervalMs: 1,
        listMessages: async () => allMessages,
        now: () => 0,
        quietGraceMs: 35_000,
        sleep: async () => undefined,
        targetTurns: 3,
        timeoutMs: 300_000
      }
    );

    assert.equal(result.agentTurns.length, 3);
    assert.equal(result.agentTurns.some((message) => message.from.id === "operator"), false);
  });
});
