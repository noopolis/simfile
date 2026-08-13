import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import test from "node:test";

import { parseWorldSurfaceDefinition } from "../world-surface/index.js";
import { validWorldSurface } from "../world-surface/definition.test-helper.js";
import {
  compileCapabilityManifests,
  parseCapabilityManifest,
  serializeCapabilityManifest,
  type CapabilityManifestCompilationInput
} from "./capabilityManifest.js";
import type { WorldAddressScope } from "./addresses.js";

const text = (bytes: readonly number[]): string => new TextDecoder().decode(Uint8Array.from(bytes));
const copy = <Value>(value: Value): Value => JSON.parse(JSON.stringify(value)) as Value;
type RootOnlyWorld = CapabilityManifestCompilationInput["world"];
const rootScopeRejectsAncestors: WorldAddressScope extends RootOnlyWorld ? false : true = true;

const rawSurface = () => {
  const surface = validWorldSurface() as {
    entities: Record<string, unknown>;
    senses: Record<string, unknown>;
    affordances: Record<string, unknown>;
    effects: Record<string, unknown>;
  };
  surface.entities.blue = { address: "entity:blue", dynamics_address: "object:player.blue" };
  surface.senses["sense:blue-view"] = {
    dynamics_senses: ["sense:state"], output: "simfile.numeric-observation.v1", project: () => ({ channels: [] })
  };
  surface.affordances["affordance:wait"] = {
    ...surface.affordances["affordance:kick"] as object,
    dynamics_action: "wait",
    target_selector: { kind: "holder" }
  };
  return surface;
};

const input = (): CapabilityManifestCompilationInput => ({
  runId: "run-1",
  worldInstanceId: "instance-1",
  world: { id: "pitch" as never },
  surfaceRegistry: parseWorldSurfaceDefinition(rawSurface()),
  grants: [{
    participant: "red", principal: "principal-red", entity: "world://pitch/entity/red" as never,
    senses: ["world://pitch/sense/vision" as never], affordances: ["world://pitch/affordance/kick" as never]
  }, {
    participant: "blue", principal: "principal-blue", entity: "world://pitch/entity/blue" as never,
    senses: ["world://pitch/sense/blue-view" as never], affordances: ["world://pitch/affordance/wait" as never]
  }]
});

test("compiles one principal-sorted, default-deny manifest per bound grant", () => {
  const artifacts = compileCapabilityManifests(input());
  assert.deepEqual(artifacts.map((item) => item.manifest.holder.principal), ["principal-blue", "principal-red"]);
  const redArtifact = artifacts[1]!;
  const blueArtifact = artifacts[0]!;
  const red = redArtifact.manifest;
  const blue = blueArtifact.manifest;
  assert.equal(red.holder.entity, "world://pitch/entity/red");
  assert.equal(blue.holder.entity, "world://pitch/entity/blue");
  assert.deepEqual(red.senses.map(({ address }) => address), ["world://pitch/sense/vision"]);
  assert.deepEqual(blue.affordances.map(({ address }) => address), ["world://pitch/affordance/wait"]);
  assert.notEqual(redArtifact.digest, blueArtifact.digest);
  assert.equal(text(redArtifact.bytes).includes("effect"), false);
  assert.equal(text(redArtifact.bytes).includes("credential"), false);
  assert.equal(compileCapabilityManifests({ ...input(), grants: [input().grants[0]!] }).length, 1);
});

test("rejects non-B18 composition data, address casts, duplicates, and effects", () => {
  const baseline = input();
  for (const bad of [
    { ...baseline, bearer: "secret" },
    { ...baseline, grants: [{ ...baseline.grants[0]!, holder: "other" }] },
    { ...baseline, grants: [{ ...baseline.grants[0]!, entity: "world://other/entity/red" }] },
    { ...baseline, grants: [{ ...baseline.grants[0]!, entity: "world://pitch/sense/vision" }] },
    { ...baseline, grants: [{ ...baseline.grants[0]!, senses: ["world://pitch/effect/impact"] }] },
    { ...baseline, grants: [{ ...baseline.grants[0]!, senses: ["world://pitch/sense/vision", "world://pitch/sense/vision"] }] },
    { ...baseline, grants: [baseline.grants[0]!, { ...baseline.grants[1]!, principal: "principal-red" }] }
  ]) assert.throws(() => compileCapabilityManifests(bad as never), /Capability manifest rejected/u);

  const forged = baseline.surfaceRegistry as unknown as Record<string, unknown>;
  assert.throws(() => compileCapabilityManifests({ ...baseline, surfaceRegistry: { ...forged } as never }), /Capability manifest rejected/u);
});

test("binds schemas, selectors, rejection codes, registry metadata, and identity into digests", () => {
  const first = compileCapabilityManifests(input())[1]!.manifest;
  const changedSchema = rawSurface() as any;
  changedSchema.affordances["affordance:kick"].input_schema.properties.force.maximum = 2;
  const schema = compileCapabilityManifests({ ...input(), surfaceRegistry: parseWorldSurfaceDefinition(changedSchema) })[1]!.manifest;
  assert.notEqual(first.affordances[0]!.input_schema_digest, schema.affordances[0]!.input_schema_digest);

  const changedSelector = rawSurface() as any;
  changedSelector.affordances["affordance:wait"].target_selector = { kind: "fixed", targets: ["entity:red"] };
  const selector = compileCapabilityManifests({ ...input(), surfaceRegistry: parseWorldSurfaceDefinition(changedSelector) })[1]!.manifest;
  assert.notEqual(first.surface.registry_digest, selector.surface.registry_digest);

  const changedCodes = rawSurface() as any;
  changedCodes.affordances["affordance:kick"].rejection_codes = ["blocked-next"];
  const codes = compileCapabilityManifests({ ...input(), surfaceRegistry: parseWorldSurfaceDefinition(changedCodes) })[1]!.manifest;
  assert.notEqual(first.affordances[0]!.rejection_codes[0], codes.affordances[0]!.rejection_codes[0]);

  const changedEffect = rawSurface() as any;
  changedEffect.effects["effect:impact"].dynamics_event = "impact-next";
  const registry = compileCapabilityManifests({ ...input(), surfaceRegistry: parseWorldSurfaceDefinition(changedEffect) })[1]!.manifest;
  assert.notEqual(first.surface.registry_digest, registry.surface.registry_digest);
  assert.notEqual(first.manifest_digest, compileCapabilityManifests({ ...input(), runId: "run-2" })[1]!.manifest.manifest_digest);
});

test("canonical bytes parse strictly and bind all self-contained digests", () => {
  const artifact = compileCapabilityManifests(input())[0]!;
  assert.deepEqual(parseCapabilityManifest(artifact.bytes), artifact.manifest);
  assert.deepEqual(serializeCapabilityManifest(artifact.manifest), artifact.bytes);
  const canonical = text(artifact.bytes);
  for (const hostile of [
    Uint8Array.from(artifact.bytes.slice(0, -1)),
    new TextEncoder().encode(`${JSON.stringify(artifact.manifest)}\n`),
    new TextEncoder().encode(canonical.replace('"version":"simfile.capability-manifest.v1"', '"version":"simfile.capability-manifest.v1","version":"simfile.capability-manifest.v1"')),
    new TextEncoder().encode(canonical.replace("run-1", "run-2")),
    new TextEncoder().encode(canonical.replace(/sha256:[a-f0-9]{64}/u, `sha256:${"0".repeat(64)}`)),
    Uint8Array.of(0xff)
  ]) assert.throws(() => parseCapabilityManifest(hostile), /./u);
});

test("is deterministic, deeply immutable, source-isolated, and callback-free", () => {
  let calls = 0;
  const surface = rawSurface();
  for (const sense of Object.values(surface.senses) as Array<{ project: () => unknown }>) sense.project = () => { calls += 1; return { channels: [] }; };
  for (const affordance of Object.values(surface.affordances) as Array<{ available: () => boolean; lower: () => object }>) {
    affordance.available = () => { calls += 1; return true; };
    affordance.lower = () => { calls += 1; return {}; };
  }
  const checked = parseWorldSurfaceDefinition(surface);
  const grants = input().grants.map((grant) => ({ ...grant, senses: [...grant.senses], affordances: [...grant.affordances] }));
  const prepared = { ...input(), surfaceRegistry: checked, grants };
  const reversed = compileCapabilityManifests({ ...prepared, grants: [...prepared.grants].reverse() });
  const normal = compileCapabilityManifests(prepared);
  assert.deepEqual(reversed.map(({ bytes }) => bytes), normal.map(({ bytes }) => bytes));
  assert.equal(calls, 0);
  const beforeManifests = normal.map(({ manifest }) => text(serializeCapabilityManifest(manifest)));
  const beforeBytes = normal.map(({ bytes }) => [...bytes]);
  (surface.senses["sense:vision"] as { dynamics_senses: string[] }).dynamics_senses[0] = "sense:changed";
  ((surface.affordances["affordance:kick"] as { input_schema: { properties: { force: { maximum: number } } } }).input_schema.properties.force).maximum = 2;
  grants[0]!.senses[0] = "world://pitch/sense/blue-view" as never;
  grants[0]!.affordances[0] = "world://pitch/affordance/wait" as never;
  assert.deepEqual(normal.map(({ manifest }) => text(serializeCapabilityManifest(manifest))), beforeManifests);
  assert.deepEqual(normal.map(({ bytes }) => [...bytes]), beforeBytes);
  assert.ok(Object.isFrozen(normal));
  assert.ok(Object.isFrozen(normal[0]!.bytes));
  assert.ok(Object.isFrozen(normal[0]!.manifest.affordances[0]!.input_schema));
  assert.throws(() => (normal[0]!.bytes as number[]).push(0), TypeError);
  assert.throws(() => (normal[0]!.manifest.senses as unknown as unknown[]).push({}), TypeError);
});

test("accepts only parsed registries and canonicalizes separately parsed declarations", () => {
  const first = rawSurface();
  const second = rawSurface();
  second.entities = Object.fromEntries(Object.entries(second.entities).reverse());
  second.senses = Object.fromEntries(Object.entries(second.senses).reverse());
  second.affordances = Object.fromEntries(Object.entries(second.affordances).reverse());
  second.effects = Object.fromEntries(Object.entries(second.effects).reverse());
  const one = compileCapabilityManifests({ ...input(), surfaceRegistry: parseWorldSurfaceDefinition(first) });
  const two = compileCapabilityManifests({ ...input(), surfaceRegistry: parseWorldSurfaceDefinition(second) });
  assert.deepEqual(one.map(({ bytes }) => bytes), two.map(({ bytes }) => bytes));
  assert.equal(one[0]!.manifest.surface.registry_digest, two[0]!.manifest.surface.registry_digest);
  assert.equal(one[0]!.manifest.manifest_digest, two[0]!.manifest.manifest_digest);
  const reorderedSenses = rawSurface();
  (reorderedSenses.senses["sense:vision"] as { dynamics_senses: string[] }).dynamics_senses = ["sense:state", "sense:aux"];
  const reversedSenses = rawSurface();
  (reversedSenses.senses["sense:vision"] as { dynamics_senses: string[] }).dynamics_senses = ["sense:aux", "sense:state"];
  const ordered = compileCapabilityManifests({ ...input(), surfaceRegistry: parseWorldSurfaceDefinition(reorderedSenses) });
  const reversedOrder = compileCapabilityManifests({ ...input(), surfaceRegistry: parseWorldSurfaceDefinition(reversedSenses) });
  assert.notEqual(ordered[0]!.manifest.surface.registry_digest, reversedOrder[0]!.manifest.surface.registry_digest);
  assert.notEqual(ordered[0]!.manifest.manifest_digest, reversedOrder[0]!.manifest.manifest_digest);
  assert.throws(() => compileCapabilityManifests({ ...input(), surfaceRegistry: { ...parseWorldSurfaceDefinition(rawSurface()) } as never }), /Capability manifest rejected/u);
});

test("redacts forged schemas and rejects hostile own data without execution", () => {
  const artifact = compileCapabilityManifests(input())[0]!;
  const secret = "SOL-SECRET-SENTINEL";
  const forged = copy(artifact.manifest) as any;
  forged.affordances[0].input_schema.properties.holder = { type: "string", maxLength: 8, const: secret };
  const bearer = copy(artifact.manifest) as any;
  bearer.affordances[0].input_schema.properties.bearer = { type: "string", maxLength: 8, const: secret };
  const actionEntity = copy(artifact.manifest) as any;
  actionEntity.affordances[0].input_schema.properties.entity = { type: "string", maxLength: 8, const: secret };
  const nestedActionEntity = copy(artifact.manifest) as any;
  nestedActionEntity.affordances[0].input_schema.properties.nested = {
    additionalProperties: false,
    properties: { entity: { type: "string", maxLength: 8, const: secret } },
    type: "object"
  };
  for (const attempt of [
    () => serializeCapabilityManifest(forged),
    () => parseCapabilityManifest(new TextEncoder().encode(`${JSON.stringify(forged)}\n`)),
    () => serializeCapabilityManifest(bearer),
    () => parseCapabilityManifest(new TextEncoder().encode(`${JSON.stringify(bearer)}\n`)),
    () => serializeCapabilityManifest(actionEntity),
    () => parseCapabilityManifest(new TextEncoder().encode(`${JSON.stringify(actionEntity)}\n`)),
    () => serializeCapabilityManifest(nestedActionEntity),
    () => parseCapabilityManifest(new TextEncoder().encode(`${JSON.stringify(nestedActionEntity)}\n`))
  ]) {
    const error = assert.throws(attempt, /Capability manifest rejected/u);
    assert.equal(String(error).includes(secret), false);
  }

  let calls = 0;
  const getter = copy(artifact.manifest) as any;
  Object.defineProperty(getter.affordances[0].input_schema.properties.force, "maximum", { enumerable: true, get: () => { calls += 1; return 1; } });
  const indexAccessor = copy(artifact.manifest) as any;
  Object.defineProperty(indexAccessor.affordances[0].rejection_codes, "0", { enumerable: true, get: () => { calls += 1; return "blocked"; } });
  const throwing = new Proxy(input(), { ownKeys: () => { calls += 1; throw new Error(secret); } });
  for (const attempt of [
    () => serializeCapabilityManifest(getter),
    () => serializeCapabilityManifest(indexAccessor),
    () => compileCapabilityManifests(throwing as never),
    () => compileCapabilityManifests(new Proxy(input(), {}) as never)
  ]) {
    const error = assert.throws(attempt, /Capability manifest rejected/u);
    assert.equal(String(error).includes(secret), false);
  }
  assert.equal(calls, 0);
});

test("revalidates participant records and hostile wire containers", () => {
  const baseline = input();
  assert.throws(() => compileCapabilityManifests({ ...baseline, grants: [baseline.grants[0]!, { ...baseline.grants[1]!, participant: "red" }] }), /Capability manifest rejected/u);
  assert.throws(() => compileCapabilityManifests({ ...baseline, grants: [{ ...baseline.grants[0]!, participant: "NOT VALID" }] }), /Capability manifest rejected/u);
  const bytes = compileCapabilityManifests(baseline)[0]!.bytes;
  assert.deepEqual(parseCapabilityManifest(Buffer.from(bytes)), parseCapabilityManifest(bytes));
  let iteratorCalls = 0;
  const nativeBytes = Uint8Array.from(bytes);
  Object.defineProperty(nativeBytes, Symbol.iterator, { value: () => { iteratorCalls += 1; return [0][Symbol.iterator](); } });
  assert.deepEqual(parseCapabilityManifest(nativeBytes), parseCapabilityManifest(bytes));
  assert.equal(iteratorCalls, 0);
  class ByteSubclass extends Uint8Array {}
  class ArraySubclass extends Array<number> {}
  const accessor = [...bytes];
  let traps = 0;
  Object.defineProperty(accessor, "0", { enumerable: true, get: () => { throw new Error("SOL-SECRET-SENTINEL"); } });
  for (const hostile of [
    new ByteSubclass(bytes), new Proxy(Uint8Array.from(bytes), {}),
    new Proxy(Uint8Array.from(bytes), { getPrototypeOf: () => { traps += 1; throw new Error("SOL-SECRET-SENTINEL"); } }),
    new ArraySubclass(...bytes), new Proxy([...bytes], {}), accessor
  ]) assert.throws(() => parseCapabilityManifest(hostile as never), /Capability manifest rejected/u);
  const secret = "SOL-SECRET-SENTINEL";
  const subclassWithIterator = new ByteSubclass(bytes);
  Object.defineProperty(subclassWithIterator, Symbol.iterator, {
    value: () => { throw new Error(secret); }
  });
  const error = assert.throws(
    () => parseCapabilityManifest(subclassWithIterator),
    /Capability manifest rejected/u
  );
  assert.equal(String(error).includes(secret), false);
  assert.throws(() => compileCapabilityManifests({ ...baseline, world: { id: "pitch" as never, ancestors: [] } as never }), /Capability manifest rejected/u);
  assert.equal(rootScopeRejectsAncestors, true);
  assert.equal(traps, 0);
});
