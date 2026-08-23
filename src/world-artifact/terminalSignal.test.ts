import assert from "node:assert/strict";
import test from "node:test";

import {
  COMPOSED_WORLD_TERMINAL_ARTIFACT,
  createComposedWorldTerminalSignal,
  parseComposedWorldTerminalSignal,
  serializeComposedWorldTerminalSignal,
} from "./terminalSignal.js";

test("composed world terminal signal is a canonical public authoring contract", () => {
  const signal = createComposedWorldTerminalSignal({
    outcome_digest: `sha256:${"a".repeat(64)}`,
    reason: "completed",
    run_id: "run-one",
    terminal_tick: 4,
  });
  assert.deepEqual(COMPOSED_WORLD_TERMINAL_ARTIFACT, {
    id: "composed_terminal",
    max_bytes: 131_072,
    path: "/tmp/spawnfile-public/composed-terminal.json",
  });
  assert.deepEqual(parseComposedWorldTerminalSignal(signal), signal);
  assert.deepEqual(
    JSON.parse(new TextDecoder().decode(serializeComposedWorldTerminalSignal(signal))),
    signal,
  );
  assert.throws(() => parseComposedWorldTerminalSignal({ ...signal, extra: true }));
});
