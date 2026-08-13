import assert from "node:assert/strict";
import test from "node:test";

import {
  readControllerPrincipalId,
  resolveCausalPrincipal,
  SIMFILE_CONTROLLER_PRINCIPAL_PREFIX,
  SIMFILE_PRINCIPAL_GRAMMAR
} from "./principal.js";

const controllerPrincipal = (controllerId: string): string =>
  resolveCausalPrincipal({
    origin: "controller",
    principalId: `controller:${controllerId}`
  });

test("keeps distinct controller identities distinguishable and decodable", () => {
  const one = controllerPrincipal("one");
  const two = controllerPrincipal("two");

  assert.notEqual(one, two);
  assert.equal(readControllerPrincipalId(one), "one");
  assert.equal(readControllerPrincipalId(two), "two");
});

test("round-trips hostile controller ids verbatim", () => {
  const controllerIds = [
    "contains.dot",
    "contains:colon",
    "controller:looking",
    "λ雪",
    "\ud800"
  ];

  for (const controllerId of controllerIds) {
    const principal = controllerPrincipal(controllerId);
    assert.match(principal, SIMFILE_PRINCIPAL_GRAMMAR);
    assert.equal(readControllerPrincipalId(principal), controllerId);
  }
  assert.equal(
    resolveCausalPrincipal({ origin: "controller", principalId: "x" }),
    controllerPrincipal("x")
  );
  assert.equal(readControllerPrincipalId("system:another"), undefined);
});

test("maps every origin and preserves grammatical principals where required", () => {
  const cases: readonly Readonly<{
    expected: string;
    input: Parameters<typeof resolveCausalPrincipal>[0];
  }>[] = [
    {
      input: { origin: "agentic", principalId: "nora" },
      expected: "agent:nora"
    },
    {
      input: { origin: "agentic", principalId: "operator:nora" },
      expected: "operator:nora"
    },
    {
      input: { origin: "controller", principalId: "controller:one" },
      expected: "system:simfile.controller.one"
    },
    {
      input: { origin: "external", principalId: "outside" },
      expected: "system:simfile.external.outside"
    },
    {
      input: { origin: "external", principalId: "system:upstream" },
      expected: "system:upstream"
    },
    {
      input: { origin: "replay", principalId: "recording" },
      expected: "system:simfile.replay.recording"
    },
    {
      input: { origin: "replay", principalId: "agent:nora" },
      expected: "agent:nora"
    }
  ];

  for (const { expected, input } of cases) {
    const principal = resolveCausalPrincipal(input);
    assert.equal(principal, expected);
    assert.match(principal, SIMFILE_PRINCIPAL_GRAMMAR);
  }

  const externalBare = resolveCausalPrincipal({
    origin: "external",
    principalId: "outside"
  });
  const replayBare = resolveCausalPrincipal({
    origin: "replay",
    principalId: "recording"
  });
  assert.equal(externalBare.startsWith(SIMFILE_CONTROLLER_PRINCIPAL_PREFIX), false);
  assert.equal(replayBare.startsWith(SIMFILE_CONTROLLER_PRINCIPAL_PREFIX), false);
});
