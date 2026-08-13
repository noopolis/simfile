import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { maxViewerTraceTick, viewerTraceTicks } from "./events.js";

describe("viewer event stream", () => {
  it("uses exact spatial samples as the live frontier", () => {
    assert.equal(maxViewerTraceTick({
      ledger_facts: [{ tick: 2 }],
      presence: [{ tick: 3 }],
      spatial_samples: [{ tick: 14 }],
    }), 14);
    assert.deepEqual(viewerTraceTicks({
      ledger_facts: [{ tick: 2 }],
      presence: [{ tick: 3 }],
      spatial_samples: [{ tick: 14 }, { tick: 3 }],
    }), [2, 3, 14]);
  });

  it("does not invent a frontier for absent data", () => {
    assert.equal(maxViewerTraceTick(null), 0);
    assert.equal(maxViewerTraceTick({ spatial_samples: [{ tick: "unknown" }] }), 0);
  });
});
