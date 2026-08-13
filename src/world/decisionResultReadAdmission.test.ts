import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { parseWorldSurfaceDefinition } from "../world-surface/index.js";
import { validWorldSurface } from "../world-surface/definition.test-helper.js";
import {
  createDecisionRegistryForTesting,
  reserveDecisionForAct,
  type DecisionRegistry,
} from "./decisionRegistry.js";
import {
  createDecisionResultReadAdmission,
  type DecisionResultReadRuntimeIdentity,
} from "./decisionResultReadAdmission.js";
import { compileCapabilityManifests } from "./capabilityManifest.js";

const config = (runId = "run-1", worldInstanceId = "instance-1") => ({
  runId, worldInstanceId, tokenDigestKey: new Uint8Array(32).fill(9),
});
const manifest = (principal = "principal-red", runId = "run-1", worldInstanceId = "instance-1") =>
  compileCapabilityManifests({
    runId, worldInstanceId, world: { id: "pitch" as never },
    surfaceRegistry: parseWorldSurfaceDefinition(validWorldSurface()),
    grants: [{ participant: principal.replace("principal-", ""), principal, entity: "world://pitch/entity/red" as never,
      senses: ["world://pitch/sense/vision" as never], affordances: ["world://pitch/affordance/kick" as never] }],
  })[0]!.manifest;
const identity = (value = manifest()): DecisionResultReadRuntimeIdentity => ({
  run_id: value.run_id, world_id: value.world.id, world_instance_id: value.world.instance_id,
  manifest_digest: value.manifest_digest, state_version: 0,
});
const registry = (runId = "run-1", instance = "instance-1"): DecisionRegistry =>
  createDecisionRegistryForTesting(config(runId, instance), { randomBytes: () => new Uint8Array(32).fill(3) });
const setup = () => {
  const decisionRegistry = registry();
  const minted = decisionRegistry.mint({ principal: "principal-red", issuedTick: 0, validThroughTick: 2 });
  const runtimeManifest = manifest();
  const runtimeIdentity = identity(runtimeManifest);
  const issuer = createDecisionResultReadAdmission({ registry: decisionRegistry, manifest: runtimeManifest, runtimeAuthority: runtimeIdentity });
  const request = (token = minted.token, extra: Record<string, unknown> = {}) => ({
    principal: "principal-red", runId: "run-1", worldInstanceId: "instance-1", token, atTick: 0,
    manifest: runtimeManifest, runtimeAuthority: runtimeIdentity, ...extra,
  });
  return { decisionRegistry, minted, runtimeManifest, runtimeIdentity, issuer, request };
};

test("only a consumed token can mint a result-read admission", () => {
  const first = setup();
  assert.throws(() => first.issuer.admit(first.request()), /Decision token admission failed/u);
  assert.equal(first.decisionRegistry.peekReadAdmission(first.request()).status, "active");
  assert.equal(first.decisionRegistry.admitRead(first.request()).status, "active");
  const before = first.decisionRegistry.snapshot();
  first.decisionRegistry.consumeForAct(first.request());
  const admission = first.issuer.admit(first.request());
  assert.equal(first.issuer.read(admission).decisionId, first.minted.decisionId);
  assert.throws(() => first.decisionRegistry.peekReadAdmission(first.request()), /already been consumed/u);
  assert.throws(() => first.decisionRegistry.admitRead(first.request()), /already been consumed/u);
  assert.throws(() => reserveDecisionForAct(first.decisionRegistry, first.request()), /already been consumed/u);
  assert.notDeepEqual(first.decisionRegistry.snapshot(), before);
  const consumed = first.decisionRegistry.inspect().decisions[0];
  assert.equal(consumed?.status, "consumed");
  assert.equal(JSON.stringify(admission).includes(first.minted.token), false);
});

test("open and cutoff admissions are replayable without registry mutation", () => {
  const first = setup();
  first.decisionRegistry.consumeForAct(first.request());
  const before = first.decisionRegistry.snapshot();
  const one = first.issuer.admit(first.request());
  const two = first.issuer.admit(first.request());
  assert.strictEqual(one, two);
  assert.deepEqual(first.issuer.read(one), first.issuer.read(two));
  assert.deepEqual(first.decisionRegistry.snapshot(), before);

  const cutoff = setup();
  cutoff.decisionRegistry.consumeForAct(cutoff.request());
  cutoff.decisionRegistry.beginCutoff(0);
  assert.equal(cutoff.issuer.read(cutoff.issuer.admit(cutoff.request())).atTick, 0);
  const closed = setup();
  closed.decisionRegistry.consumeForAct(closed.request());
  closed.decisionRegistry.beginCutoff(0);
  closed.decisionRegistry.closeAdmissions(0);
  assert.throws(() => closed.issuer.admit(closed.request()), /Decision admissions are closed/u);
  const finalized = setup();
  finalized.decisionRegistry.consumeForAct(finalized.request());
  finalized.decisionRegistry.beginCutoff(0); finalized.decisionRegistry.closeAdmissions(0); finalized.decisionRegistry.finalize(0);
  assert.throws(() => finalized.issuer.admit(finalized.request()), /Decision admissions are closed/u);
});

test("expiration fails closed and never resurrects consumed authority", () => {
  const first = registry();
  const short = first.mint({ principal: "principal-blue", issuedTick: 0, validThroughTick: 0 });
  first.consumeForAct({ principal: "principal-blue", runId: "run-1", worldInstanceId: "instance-1", token: short.token, atTick: 0 });
  const blueManifest = manifest("principal-blue");
  const blueIdentity = { ...identity(blueManifest), state_version: 1 };
  const blueIssuer = createDecisionResultReadAdmission({ registry: first, manifest: blueManifest, runtimeAuthority: blueIdentity });
  assert.throws(() => blueIssuer.admit({ principal: "principal-blue", runId: "run-1", worldInstanceId: "instance-1", token: short.token, atTick: 1, manifest: blueManifest, runtimeAuthority: blueIdentity }), /Decision token has expired/u);
  assert.equal(first.inspect().decisions.at(-1)?.status, "consumed");
});

test("binding substitutions, cross-issued authorities, and hostile shapes fail closed", () => {
  const first = setup();
  first.decisionRegistry.consumeForAct(first.request());
  const blue = setup();
  blue.decisionRegistry.consumeForAct(blue.request());
  const bad = [
    first.request(first.minted.token, { principal: "principal-blue" }),
    first.request(first.minted.token, { runId: "run-2" }),
    first.request(first.minted.token, { worldInstanceId: "instance-2" }),
    first.request(first.minted.token, { manifest: blue.runtimeManifest }),
    first.request(first.minted.token, { runtimeAuthority: blue.runtimeIdentity }),
    { ...first.request(), token: "malformed" },
    { ...first.request(), extra: true },
    Object.defineProperty({ ...first.request() }, "token", { enumerable: true, get: () => first.minted.token }),
    Object.assign(Object.create(null), first.request()),
    new Proxy(first.request(), {}),
  ];
  for (const request of bad) assert.throws(() => first.issuer.admit(request), /Invalid result-read admission request|Invalid decision registry input|Decision token admission failed|Decision token has expired/u);
  assert.throws(() => first.issuer.read(Object.freeze({})), /Invalid result-read admission/u);
  const forged = Object.freeze({});
  assert.throws(() => first.issuer.read(forged), /Invalid result-read admission/u);
  const foreignAdmission = blue.issuer.admit(blue.request());
  assert.throws(() => first.issuer.read(foreignAdmission), /Invalid result-read admission/u);
  assert.equal(JSON.stringify(first.issuer).includes("registry"), false);
});

test("manifest and runtime identity are coherently bound and never public", () => {
  const first = setup();
  first.decisionRegistry.consumeForAct(first.request());
  const changed = { ...first.runtimeManifest, manifest_digest: `sha256:${"0".repeat(64)}` };
  assert.throws(() => createDecisionResultReadAdmission({ registry: first.decisionRegistry, manifest: changed, runtimeAuthority: first.runtimeIdentity }), /Invalid result-read admission issuer/u);
  const admission = first.issuer.admit(first.request());
  const output = first.issuer.read(admission);
  assert.deepEqual(Object.keys(output).sort(), ["atTick", "decisionId", "issuedTick", "manifestDigest", "principal", "runId", "validThroughTick", "worldInstanceId"].sort());
  for (const secret of [first.minted.token, "tokenDigest", "tokenDigestKey", "reserve", "commit", "abort", "registry"]) {
    assert.equal(JSON.stringify(output).includes(secret), false, secret);
  }
  const worldIndex = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
  const rootIndex = readFileSync(new URL("../index.ts", import.meta.url), "utf8");
  assert.equal(`${worldIndex}\n${rootIndex}`.includes("decisionResultReadAdmission"), false);
});

test("binds exact manifest and runtime identity references, holder, and tick", () => {
  const first = setup();
  first.decisionRegistry.consumeForAct(first.request());
  const manifestClone = JSON.parse(JSON.stringify(first.runtimeManifest)) as typeof first.runtimeManifest;
  const identityClone = { ...first.runtimeIdentity };
  for (const request of [
    first.request(first.minted.token, { manifest: manifestClone }),
    first.request(first.minted.token, { runtimeAuthority: identityClone }),
    first.request(first.minted.token, { atTick: 1 }),
  ]) assert.throws(() => first.issuer.admit(request), /Invalid result-read admission request/u);

  const holderMismatch = setup();
  holderMismatch.decisionRegistry.consumeForAct(holderMismatch.request());
  const blueManifest = manifest("principal-blue");
  const blueIdentity = identity(blueManifest);
  assert.throws(() => createDecisionResultReadAdmission({ registry: holderMismatch.decisionRegistry, manifest: blueManifest, runtimeAuthority: blueIdentity }).admit({
    principal: "principal-red", runId: "run-1", worldInstanceId: "instance-1", token: holderMismatch.minted.token,
    atTick: 0, manifest: blueManifest, runtimeAuthority: blueIdentity,
  }), /Invalid result-read admission request/u);

  for (const invalid of [
    { ...first.runtimeManifest, manifest_digest: `sha256:${"0".repeat(64)}` },
    { ...first.runtimeManifest, holder: { ...first.runtimeManifest.holder, entity: "world://pitch/entity/ball" } },
    { ...first.runtimeManifest, surface: { ...first.runtimeManifest.surface, registry_digest: "sha256:bad" } },
    { ...first.runtimeManifest, affordances: [{ ...first.runtimeManifest.affordances[0]!, rejection_codes: ["forged", "forged"] }] },
  ]) assert.throws(() => createDecisionResultReadAdmission({ registry: first.decisionRegistry, manifest: invalid, runtimeAuthority: first.runtimeIdentity }), /Invalid result-read admission issuer/u);
});

test("fails closed after mutable canonical manifest or identity mutation", () => {
  const first = setup();
  const mutableManifest = JSON.parse(JSON.stringify(first.runtimeManifest)) as any;
  const mutableIdentity = { ...first.runtimeIdentity };
  const issuer = createDecisionResultReadAdmission({ registry: first.decisionRegistry, manifest: mutableManifest, runtimeAuthority: mutableIdentity });
  const request = (atTick: number) => ({ principal: "principal-red", runId: "run-1", worldInstanceId: "instance-1", token: first.minted.token, atTick, manifest: mutableManifest, runtimeAuthority: mutableIdentity });
  first.decisionRegistry.consumeForAct(request(0));
  const admission = issuer.admit(request(0));
  const original = issuer.read(admission);
  const before = first.decisionRegistry.snapshot();
  mutableIdentity.state_version = 1;
  mutableManifest.manifest_digest = `sha256:${"0".repeat(64)}`;
  (mutableManifest.affordances[0]!.rejection_codes as string[]).push("forged");
  assert.throws(() => issuer.admit(request(1)), /Invalid result-read admission request/u);
  assert.deepEqual(first.decisionRegistry.snapshot(), before);
  assert.deepEqual(issuer.read(admission), original);
  assert.equal(issuer.read(admission).manifestDigest, first.runtimeManifest.manifest_digest);
});

test("does not invoke mutated identity accessors during admission", () => {
  const first = setup();
  const mutableIdentity = { ...first.runtimeIdentity };
  const issuer = createDecisionResultReadAdmission({ registry: first.decisionRegistry, manifest: first.runtimeManifest, runtimeAuthority: mutableIdentity });
  const request = () => ({ principal: "principal-red", runId: "run-1", worldInstanceId: "instance-1", token: first.minted.token,
    atTick: 0, manifest: first.runtimeManifest, runtimeAuthority: mutableIdentity });
  first.decisionRegistry.consumeForAct(request());
  const before = first.decisionRegistry.snapshot();
  let invocations = 0;
  Object.defineProperty(mutableIdentity, "state_version", { enumerable: true, configurable: true, get: () => { invocations += 1; throw new Error("hostile getter"); } });
  assert.throws(() => issuer.admit(request()), /Invalid result-read admission request/u);
  assert.equal(invocations, 0);
  assert.deepEqual(first.decisionRegistry.snapshot(), before);
});

test("issuer markers isolate identical bindings and the verifier seam is write-once", async () => {
  const first = setup();
  first.decisionRegistry.consumeForAct(first.request());
  const second = createDecisionResultReadAdmission({ registry: first.decisionRegistry, manifest: first.runtimeManifest, runtimeAuthority: first.runtimeIdentity });
  const admission = first.issuer.admit(first.request());
  assert.strictEqual(first.issuer.admit(first.request()), admission);
  assert.throws(() => second.read(admission), /Invalid result-read admission/u);
  const reverse = second.admit(first.request());
  assert.throws(() => first.issuer.read(reverse), /Invalid result-read admission/u);

  const moduleText = readFileSync(new URL("./decisionRegistry.ts", import.meta.url), "utf8");
  assert.equal(moduleText.includes("export const verifyConsumedDecisionResultRead"), false);
  const admissionModule = await import("./decisionResultReadAdmission.js");
  assert.equal("verifyConsumedDecisionResultRead" in admissionModule, false);
  assert.throws(() => admissionModule.registerConsumedDecisionResultVerifier(first.decisionRegistry as object, () => {
    throw new Error("forged");
  }), /registration rejected/u);
});
