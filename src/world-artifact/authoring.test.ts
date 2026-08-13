import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { parseSimfileSource } from "../schema/parse.js";
import { parseWorldSurfaceDefinition } from "../world-surface/index.js";
import { createWorldServiceContract } from "./artifact.js";
import {
  compileAuthoredWorldCapabilities,
  createWorldSidecarAuthoringBinding,
} from "./authoring.js";
import {
  createPreparedWorldSidecarInputDigest,
  loadOrCreatePreparedWorldSidecarBundle,
} from "./preparedBundleCache.js";
import { prepareAuthoredWorldSidecarBundle } from "./prepare.js";

const contract = createWorldServiceContract({
  adapters: { json: "WorldJsonServer", mcp: "WorldMcpProtocolServer" },
  capability_manifest: "simfile.capability-manifest.v1",
  dynamics_provider: "simfile.dynamics-provider.v1",
  handler: "WorldRequestHandler",
  operations: ["status"],
  spawnfile_receipts: ["spawnfile.target-resource.receipt.v1"],
  world_act_request: "simfile.world-act-request.v1",
  world_bindings: "simfile.world-bindings.v1",
  world_checkpoint: "simfile.world-checkpoint.v1",
  world_runtime: "WorldRuntime",
  world_surface: "simfile.world-surface.v1",
});

const simfile = (name: string, scale: number): string => `simfile_version: "0.1"
name: ${name}
clock:
  seed: ${name}-seed
  tick: 1s
  sim_per_tick: 1s
dynamics:
  module: ./provider.mjs
  config:
    scale: ${scale}
`;

const project = async (root: string, name: string): Promise<{
  composer: string;
  simfile: string;
}> => {
  const directory = path.join(root, name);
  await mkdir(directory);
  const composer = path.join(directory, "composer.ts");
  const simfilePath = path.join(directory, "Simfile");
  await writeFile(path.join(directory, "provider.mjs"),
    "export const createDynamicsProvider = () => ({ project: 'neutral' });\n");
  await writeFile(composer,
    "export const composeWorldRuntime = () => __NEUTRAL_CONFIGURATION__;\n");
  await writeFile(simfilePath, simfile(name, 1));
  return { composer, simfile: simfilePath };
};

const prepareProject = async (
  sourceRoot: string,
  files: Awaited<ReturnType<typeof project>>,
) => prepareAuthoredWorldSidecarBundle({
  binding: createWorldSidecarAuthoringBinding({
    composer: { entry_point: path.relative(sourceRoot, files.composer) },
    dependency_root: sourceRoot,
    evidence_root: "/var/lib/simfile/neutral-evidence",
    network: { dns_alias: "world", internal_port: 4070 },
    secrets: {
      declarations: [{ name: "world_bearer", principal: "principal:neutral", scope: "world" }],
      root: "/run/simfile-neutral-secrets",
    },
    service_contract: contract,
    simfile_path: files.simfile,
    source_root: sourceRoot,
  }),
  create_composer_settings: ({ provider }) => ({
    defines: {
      __NEUTRAL_CONFIGURATION__: JSON.stringify(provider.config),
    },
    identity: {
      build_receipt: provider.receipt,
      configuration: provider.config,
      provider_provenance: {
        artifact_sha256: provider.receipt.payload.artifact_sha256,
        api_version: "simfile.dynamics-provider.v1",
      },
    },
  }),
});

test("two neutral authored projects produce stable bundles and track source/config changes", async () => {
  const sourceRoot = process.cwd();
  const root = await mkdtemp(path.join(sourceRoot, "world-authoring-"));
  try {
    const alpha = await project(root, "neutral-alpha");
    const beta = await project(root, "neutral-beta");
    const alphaFirst = await prepareProject(sourceRoot, alpha);
    const alphaSecond = await prepareProject(sourceRoot, alpha);
    const betaFirst = await prepareProject(sourceRoot, beta);
    const betaSecond = await prepareProject(sourceRoot, beta);
    assert.deepEqual(alphaSecond.bundle, alphaFirst.bundle);
    assert.deepEqual(betaSecond.bundle, betaFirst.bundle);
    assert.notEqual(alphaFirst.bundle.manifest.digest, betaFirst.bundle.manifest.digest);

    await writeFile(alpha.composer,
      "export const composeWorldRuntime = () => ({ ...__NEUTRAL_CONFIGURATION__, source: 2 });\n");
    const sourceChanged = await prepareProject(sourceRoot, alpha);
    assert.notEqual(sourceChanged.bundle.manifest.digest, alphaFirst.bundle.manifest.digest);
    await writeFile(alpha.composer,
      "export const composeWorldRuntime = () => __NEUTRAL_CONFIGURATION__;\n");
    await writeFile(alpha.simfile, simfile("neutral-alpha", 2));
    const configChanged = await prepareProject(sourceRoot, alpha);
    assert.notEqual(configChanged.bundle.manifest.digest, alphaFirst.bundle.manifest.digest);

    const cacheRoot = path.join(root, "cache");
    const inputDigest = await createPreparedWorldSidecarInputDigest({
      identity: { config: 1 },
      inputs: [{ absolute_path: path.dirname(beta.simfile), label: "project" }],
    });
    let builds = 0;
    const firstCache = await loadOrCreatePreparedWorldSidecarBundle({
      build: async () => { builds += 1; return betaFirst.bundle; },
      cache_root: cacheRoot,
      input_digest: inputDigest,
    });
    const secondCache = await loadOrCreatePreparedWorldSidecarBundle({
      build: async () => { builds += 1; return betaFirst.bundle; },
      cache_root: cacheRoot,
      input_digest: inputDigest,
    });
    assert.equal(firstCache.cache.status, "miss");
    assert.equal(secondCache.cache.status, "hit");
    assert.equal(builds, 1);
    await writeFile(firstCache.cache.path, "{}\n");
    await assert.rejects(loadOrCreatePreparedWorldSidecarBundle({
      build: async () => { builds += 1; return betaFirst.bundle; },
      cache_root: cacheRoot,
      input_digest: inputDigest,
    }), /cache rejected: cache schema mismatch/u);
    assert.equal(builds, 1, "corrupt cache fails closed before rebuild");

    const changedIdentity = await createPreparedWorldSidecarInputDigest({
      identity: { config: 2 },
      inputs: [{ absolute_path: path.dirname(beta.simfile), label: "project" }],
    });
    assert.notEqual(changedIdentity, inputDigest);
    await writeFile(path.join(path.dirname(beta.simfile), "extra.ts"), "export const changed = true;\n");
    assert.notEqual(await createPreparedWorldSidecarInputDigest({
      identity: { config: 1 },
      inputs: [{ absolute_path: path.dirname(beta.simfile), label: "project" }],
    }), inputDigest);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("authored capability helper owns resolve, principal binding, and compilation", () => {
  const world = parseSimfileSource(`simfile_version: "0.1"
name: neutral-capabilities
clock:
  seed: neutral-capabilities
  tick: 1s
world:
  id: workspace
  grants:
    member:
      entity: entity:member
      senses: [sense:status]
      affordances: [affordance:update]
`).simfile.world!;
  const surface = parseWorldSurfaceDefinition({
    affordances: {
      "affordance:update": {
        available: () => true,
        dynamics_action: "update",
        input_schema: {
          additionalProperties: false,
          properties: {},
          required: [],
          type: "object",
        },
        lower: () => ({}),
        rejection_codes: ["unavailable"],
        target_selector: { kind: "holder" },
      },
    },
    api_version: "simfile.world-surface.v1",
    effects: {},
    entities: {
      member: { address: "entity:member", dynamics_address: "object:member" },
    },
    senses: {
      "sense:status": {
        dynamics_senses: ["sense:state"],
        output: "simfile.numeric-observation.v1",
        project: () => ({ channels: [] }),
      },
    },
  });
  const output = compileAuthoredWorldCapabilities({
    principal_resolver: {
      resolveParticipant: (principal) => principal === "principal:member" ? "member" : undefined,
      resolvePrincipal: (participant) => participant === "member" ? "principal:member" : undefined,
    },
    run_id: "run-neutral",
    surface_registry: surface,
    world,
    world_instance_id: "world-neutral",
  });
  assert.equal(output.resolved_grants[0]?.participant, "member");
  assert.equal(output.bound_grants[0]?.principal, "principal:member");
  assert.equal(output.manifests[0]?.manifest.run_id, "run-neutral");
});

test("authoring binding rejects project composer escape", async () => {
  const sourceRoot = process.cwd();
  const raw = await readFile(path.join(sourceRoot, "package.json"), "utf8");
  assert.ok(raw.length > 0);
  assert.throws(() => createWorldSidecarAuthoringBinding({
    composer: { entry_point: "../foreign.ts" },
    dependency_root: sourceRoot,
    evidence_root: "/var/lib/simfile/evidence",
    network: { dns_alias: "world", internal_port: 4070 },
    secrets: { declarations: [], root: "/run/simfile-secrets" },
    service_contract: contract,
    simfile_path: path.join(sourceRoot, "package.json"),
    source_root: sourceRoot,
  }), /composer entry point/u);
});
