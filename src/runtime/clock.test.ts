import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parseClockSpec } from "./clock.js";

describe("parseClockSpec", () => {
  it("defaults sim_per_tick only when it is undefined", () => {
    assert.equal(parseClockSpec({ seed: "clock", tick: "2s" }).simPerTickSeconds, 2);
    assert.equal(parseClockSpec({ seed: "clock", tick: "2s", sim_per_tick: undefined }).simPerTickSeconds, 2);
    for (const value of ["", null, false, 0]) {
      assert.throws(
        () => parseClockSpec({
          seed: "clock",
          sim_per_tick: value,
          tick: "2s"
        } as unknown as Parameters<typeof parseClockSpec>[0]),
        /invalid duration literal|must be a duration string/u
      );
    }
  });

  it("rejects duration multiplication overflow", () => {
    const overflowing = `1${"0".repeat(307)}w`;
    assert.throws(
      () => parseClockSpec({ seed: "clock", tick: overflowing }),
      /clock tick must be positive and finite/u
    );
    assert.throws(
      () => parseClockSpec({ seed: "clock", tick: "1s", sim_per_tick: overflowing }),
      /clock sim_per_tick must be positive and finite/u
    );
  });
});
