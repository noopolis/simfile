import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

describe("composed supervision autonomy ratchet", () => {
  it("contains only service/world terminal inputs", async () => {
    const source = await readFile(new URL("./supervision.ts", import.meta.url), "utf8");
    for (const forbidden of [
      "pendingAgent", "pending_agent", "triggerTurn", "trigger_turn", "pollDecision",
      "poll_decision", "agentReplies", "agent_replies", "minimumActionCount",
      "minimum_action_count", "modelLatency", "model_latency", "send_nudge",
    ]) assert.equal(source.includes(forbidden), false, forbidden);
    assert.match(source, /waitForWorldTerminal/u);
    assert.match(source, /operator_timeout_ms/u);
  });

  it("the production port waits only for the world-owned terminal artifact", async () => {
    const source = await readFile(new URL("../spawnfile/productionPorts.ts", import.meta.url), "utf8");
    const start = source.indexOf("supervision: {");
    const end = source.indexOf("world_finalization:", start);
    assert.notEqual(start, -1);
    assert.notEqual(end, -1);
    const supervision = source.slice(start, end);
    assert.match(supervision, /waitForProductionWorldTerminal/u);
    for (const forbidden of ["agent", "decision", "reply", "model", "action_count"]) {
      assert.equal(supervision.includes(forbidden), false, forbidden);
    }
    const terminal = await readFile(
      new URL("../spawnfile/productionTerminal.ts", import.meta.url), "utf8",
    );
    assert.match(terminal, /terminal_artifact/u);
    for (const forbidden of ["agent", "decision", "reply", "model", "action_count"]) {
      assert.equal(terminal.includes(forbidden), false, forbidden);
    }
  });
});
