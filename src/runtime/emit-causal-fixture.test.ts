import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { emitCausalFixtureJsonl } from "./emit-causal-fixture.js";

describe("emitCausalFixtureJsonl", () => {
  it("prints one schema-shaped noopolis.causal-event.v1 JSON record per line", () => {
    const lines = emitCausalFixtureJsonl();
    assert.ok(lines.length > 0);

    for (const line of lines) {
      assert.equal(line.includes("\n"), false);
      const record = JSON.parse(line) as {
        version: string;
        run_id: string;
        event_id: string;
        emitter: { system: string; stream_id: string; seq: number };
        type: string;
        principal_id: string;
        recorded_at: string;
        cause_event_ids: string[];
        payload: Record<string, unknown>;
      };
      assert.equal(record.version, "noopolis.causal-event.v1");
      assert.equal(record.emitter.system, "simfile");
      assert.equal(record.principal_id, "system:simfile.world");
    }
  });

  it("is deterministic for identical env-derived inputs", () => {
    assert.deepEqual(emitCausalFixtureJsonl(), emitCausalFixtureJsonl());
  });
});
