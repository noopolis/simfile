import assert from "node:assert/strict";
import test from "node:test";

import type { ComposedExecution } from "../compose/execution.js";
import { lifecycleRequest } from "../compose/lifecycle.test-helper.js";
import { createProductionComposedRunPorts } from "./productionPorts.js";

test("production ports reject lifecycle preparation without a released generic target provider", async () => {
  const request = lifecycleRequest();
  const ports = createProductionComposedRunPorts({
    execution: {
      configuration: { topology_expectation: { selected_target: {
        fingerprint: `sha256:${"1".repeat(32)}`, handle: `opaque_${"2".repeat(16)}`,
      } } },
      provider: { spawnfile_bin: "/spawnfile", spawnfile_cwd: "/", spawnfile_executable_sha256: `sha256:${"3".repeat(64)}` },
      secret_bindings: [],
    } as unknown as ComposedExecution,
    journal_session: { assertCurrent: async () => undefined } as never,
  });
  await assert.rejects(ports.preparation.prepareComposedRun({
    idempotency_key: `idem_${"a".repeat(16)}`,
    request,
    signal: new AbortController().signal,
  }), /released consumer-neutral Spawnfile target provider/u);
});
