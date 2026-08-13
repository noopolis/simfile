import assert from "node:assert/strict";
import test from "node:test";

import { createWorldServiceEntrypoint } from "./entrypoint.js";

test("rejects hostile entrypoint envelopes before runtime inputs are consumed", () => {
  let runtimeReads = 0;
  const runtimeInput = Object.defineProperty({}, "dynamics", { enumerable: true, get: () => { runtimeReads += 1; return null; } });
  for (const input of [
    { runtime_input: runtimeInput, resolveBearer: "not-a-function" },
    { get runtime_input(): unknown { throw new Error("read"); }, resolveBearer: () => undefined },
    { runtime_input: runtimeInput, resolveBearer: () => undefined, extra: true },
    new Proxy({ runtime_input: runtimeInput, resolveBearer: () => undefined }, {}),
    { runtime_input: runtimeInput, resolveBearer: new Proxy(() => undefined, {}) },
  ]) {
    assert.throws(() => createWorldServiceEntrypoint(input as never), /invalid world service entrypoint configuration/u);
    assert.equal(runtimeReads, 0);
  }
});

test("rejects hostile nested runtime inputs in a valid envelope before construction", () => {
  let reads = 0;
  const resolver = (): undefined => undefined;
  const fields = ["dynamics", "surfaceRegistry", "capabilityManifests", "boundGrants", "decisionRegistry", "readLedger"];
  const validShape = (): Record<string, object> => Object.fromEntries(fields.map((field) => [field, {}]));
  const hostile = [
    new Proxy(validShape(), {}),
    Object.defineProperty(validShape(), "dynamics", { enumerable: true, get: () => { reads += 1; return {}; } }),
    { ...validShape(), extra: {} },
    Object.fromEntries(fields.slice(1).map((field) => [field, {}])),
    (() => { const shared = {}; return Object.fromEntries(fields.map((field) => [field, shared])); })(),
  ];
  for (const runtime_input of hostile) {
    assert.throws(() => createWorldServiceEntrypoint({ runtime_input: runtime_input as never, resolveBearer: resolver }), /invalid world service entrypoint configuration/u);
    assert.equal(reads, 0);
  }
});
