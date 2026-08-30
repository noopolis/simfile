import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

import { ensurePublicPackageBuild } from "../publicPackageBuild.test-helper.js";

const packageRoot = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));
const exampleRoot = path.join(
  packageRoot,
  "examples",
  "composed-development",
);
const simfilePath = path.join(exampleRoot, "Simfile");
const spawnfilePath = path.join(exampleRoot, "org", "Spawnfile");
const digest = (character: string): `sha256:${string}` =>
  `sha256:${character.repeat(64)}`;

const extractBundle = async (bytes: readonly number[], destination: string): Promise<void> => {
  const archive = Uint8Array.from(bytes);
  let offset = 0;
  const admitted = new Set([
    "bundle.json", "world-artifact/composer.mjs", "world-artifact/entrypoint.mjs",
    "world-artifact/manifest.json", "world-artifact/provider.mjs",
    "world-artifact/runner.mjs",
  ]);
  while (offset + 512 <= archive.byteLength && archive[offset] !== 0) {
    const header = archive.subarray(offset, offset + 512);
    const nameEnd = header.indexOf(0);
    const name = new TextDecoder().decode(header.subarray(0, nameEnd));
    const rawSize = new TextDecoder().decode(header.subarray(124, 136))
      .replace(/\0.*$/u, "").trim();
    const size = Number.parseInt(rawSize, 8);
    assert.equal(admitted.delete(name), true, name);
    assert.equal(header[156], 0x30, name);
    assert.equal(Number.isSafeInteger(size) && size >= 0, true, name);
    const start = offset + 512;
    const target = path.join(destination, name);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, archive.subarray(start, start + size), { flag: "wx" });
    offset = start + Math.ceil(size / 512) * 512;
  }
  assert.equal(admitted.size, 0);
  assert.equal(offset + 1024, archive.byteLength);
};

const readEventually = async (file: string): Promise<Uint8Array> => {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try { return await readFile(file); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await delay(2);
  }
  throw new Error(`timed out waiting for ${path.basename(file)}`);
};

const principalResolver = Object.freeze({
  resolveParticipant: (principal: string) =>
    principal === "agent:smoke" ? "smoke" : undefined,
  resolvePrincipal: (participant: string) =>
    participant === "smoke" ? "agent:smoke" : undefined,
});

const initialCheckpoint = async (runId: string, seed: string) => {
  const [dynamics, schema, world, worldArtifact, worldSurface] = await Promise.all([
    import(["simfile", "dynamics"].join("/")) as Promise<typeof import("../dynamics/index.js")>,
    import(["simfile", "schema"].join("/")) as Promise<typeof import("../schema/index.js")>,
    import(["simfile", "world"].join("/")) as Promise<typeof import("../world/index.js")>,
    import(["simfile", "world-artifact"].join("/")) as Promise<typeof import("./index.js")>,
    import(["simfile", "world-surface"].join("/")) as Promise<typeof import("../world-surface/index.js")>,
  ]);
  const parsed = schema.parseSimfileSource(await readFile(simfilePath, "utf8"), {
    path: simfilePath,
  });
  assert.ok(parsed.simfile.world);
  const session = await dynamics.loadDynamicsSession(parsed.simfile, {
    seed,
    simfilePath,
  });
  assert.ok(session);
  const surfaceModule = await import(pathToFileURL(
    path.join(exampleRoot, "world", "surface.mjs"),
  ).href) as { createWorldSurfaceDefinition(): unknown };
  const runtime = world.createWorldRuntime(world.composeWorldRuntimeInput({
    principalResolver,
    runId,
    session,
    surfaceRegistry: worldSurface.parseWorldSurfaceDefinition(
      surfaceModule.createWorldSurfaceDefinition(),
    ),
    world: parsed.simfile.world,
    worldInstanceId: "composed-development-world",
  }));
  return worldArtifact.captureWorldCheckpoint(runtime);
};

test("standalone composed-development example builds and prepares exact contracts", async () => {
  await ensurePublicPackageBuild(packageRoot);
  const bindingModule = await import(`${pathToFileURL(
    path.join(exampleRoot, "binding.mjs"),
  ).href}?contract=${Date.now()}`) as {
    composedProjectBinding: {
      prepareComposedProject(input: unknown): Promise<any>;
      version: string;
    };
  };
  assert.equal(
    bindingModule.composedProjectBinding.version,
    "simfile.composed-project-binding.v1",
  );
  const runId = "composed-development-contract";
  const seed = "composed-development-contract-seed";
  const preparation = await bindingModule.composedProjectBinding.prepareComposedProject({
    base_image_config_digest: digest("a"),
    evidence_root: "/var/lib/simfile/evidence",
    internal_port: 4070,
    organization_container_name: "composed-development",
    platform: {
      architecture: process.arch === "arm64" ? "arm64" : "amd64",
      os: "linux",
    },
    run_id: runId,
    secret_root: "/run/spawnfile-secrets",
    seed,
    simfile_path: simfilePath,
    spawnfile_path: spawnfilePath,
  });

  assert.equal(preparation.bundle.manifest.digest,
    preparation.readiness_expectation.bundle_digest);
  assert.equal(preparation.bundle.manifest.artifact.service_digest,
    preparation.readiness_expectation.artifact_digest);
  assert.deepEqual(preparation.bundle.manifest.composer.provenance.source_graph.map(
    ({ path: sourcePath }: { path: string }) => sourcePath,
  ), [
    "examples/composed-development/world/composer.mjs",
    "examples/composed-development/world/evidence.mjs",
    "examples/composed-development/world/surface.mjs",
  ]);
  assert.deepEqual(preparation.credentials, [{
    bytes: 32,
    env: "SIMFILE_WORLD_TOKEN",
    kind: "generated-token",
    name: "world_token",
  }]);
  assert.deepEqual(preparation.secret_bindings, [{
    credential_name: "world_token",
    name: "world_token",
    scope: "world",
  }]);
  assert.equal(preparation.world_members.length, 1);
  assert.equal(preparation.world_members[0].id, "smoke");
  assert.equal(preparation.world_members[0].principal_id, "agent:smoke");
  assert.deepEqual(preparation.evidence_artifacts, [
    { path: "actions/accepted.json", role: "accepted-action", source: "actions/accepted-strategic-actions.json" },
    { path: "actions/results.jsonl", role: "action-result", source: "actions/results.jsonl" },
    { path: "identity/principals.json", role: "identity", source: "projections/principals.json" },
    { path: "probes/lifecycle-replay.json", role: "probe", source: "projections/lifecycle-replay-probe.json" },
    { path: "replay/accepted-actions.jsonl", role: "accepted-action", source: "actions/replay-accepted-actions.jsonl" },
    { path: "replay/expected.json", role: "terminal", source: "projections/replay-expected.json" },
    { path: "replay/initial-checkpoint.json", role: "world-checkpoint", source: "checkpoints/initial.json" },
    { path: "replay/terminal-checkpoint.json", role: "world-checkpoint", source: "checkpoints/terminal.json" },
    { path: "world/frames.jsonl", role: "world-frame", source: "projections/frames.jsonl" },
    { path: "world/terminal-state.json", role: "provenance", source: "projections/terminal-state.json" },
  ]);

  const checkpoint = await initialCheckpoint(runId, seed);
  const publicWorldArtifact = await import(
    ["simfile", "world-artifact"].join("/")
  ) as typeof import("./index.js");
  const identity = publicWorldArtifact.worldReadinessIdentity(checkpoint);
  const hashes = publicWorldArtifact.worldReadinessHashes(checkpoint);
  assert.equal(preparation.readiness_expectation.run_id, identity.run_id);
  assert.equal(preparation.readiness_expectation.world_instance_id,
    identity.world_instance_id);
  assert.deepEqual(preparation.readiness_expectation.capability_manifest_digests,
    identity.capability_manifest_digests);
  assert.equal(preparation.readiness_expectation.mechanics_sha256, hashes.mechanics);
  assert.equal(preparation.readiness_expectation.normalized_checkpoint_sha256,
    hashes.normalized_checkpoint);
  assert.doesNotThrow(() => publicWorldArtifact.verifyWorldSidecarReadiness({
    ...preparation.readiness_expectation,
    clock: { next_tick: 0, state: "paused" },
    decisions: { count: 0, phase: "open" },
    runtime_abi: preparation.bundle.manifest.runtime_abi,
    status: "ready",
    version: "simfile.world-sidecar-readiness.v1",
  }, preparation.readiness_expectation));

  const replayState = await preparation.replay_adapter.restore(checkpoint);
  const replay = await preparation.replay_adapter.finish(replayState);
  assert.equal(replay.terminal_tick, 4);
  const terminal = JSON.parse(new TextDecoder().decode(replay.terminal_state)) as {
    dynamics: { next_tick: number; provider_state: { value: number } };
    version: string;
  };
  assert.equal(terminal.version,
    "simfile.composed-lifecycle-replay-terminal.v1");
  assert.equal(terminal.dynamics.next_tick, 4);
  assert.equal(terminal.dynamics.provider_state.value, 4);
  const probe = JSON.parse(new TextDecoder().decode(replay.probe)) as {
    live_agent_action: string;
    passed: boolean;
  };
  assert.deepEqual(probe, {
    live_agent_action: "not_evaluated",
    passed: true,
    run_id: runId,
    terminal_tick: 4,
    version: "simfile.composed-lifecycle-replay-smoke.v1",
  });
  await assert.rejects(Promise.resolve().then(() =>
    preparation.replay_adapter.inject({
      action: {}, boundary_tick: 0, ordinal: 0, state: replayState,
    })), /accepts no recorded actions/u);
});

test("composed-development example has no checkout, private-source, or machine spillover", async () => {
  const files = [
    "binding.mjs",
    "harness/scripted-engine.mjs",
    "world/composer.mjs",
    "world/evidence.mjs",
    "world/provider.mjs",
    "world/surface.mjs",
  ];
  for (const relative of files) {
    const source = await readFile(path.join(exampleRoot, relative), "utf8");
    assert.doesNotMatch(source,
      /(?:\/Users\/[^/]+\/|\/home\/[^/]+\/|[A-Za-z]:\\Users\\[^\\]+\\|gpu[-_ ]?[0-9]{3,5}|\/src\/|\.\.\/spawnfile)/iu,
      relative);
    for (const match of source.matchAll(/\bfrom\s+["']([^"']+)["']/gu)) {
      const specifier = match[1]!;
      assert.ok(specifier.startsWith("node:")
        || specifier.startsWith("simfile/")
        || specifier.startsWith("./"), `${relative}: ${specifier}`);
      if (relative === "world/composer.mjs") {
        assert.ok(specifier.startsWith("./"), `${relative}: ${specifier}`);
      }
    }
  }
  const spawnfile = await readFile(spawnfilePath, "utf8");
  const agent = await readFile(
    path.join(exampleRoot, "org", "agents", "smoke", "Spawnfile"),
    "utf8",
  );
  assert.doesNotMatch(`${spawnfile}\n${agent}`, /(?:networks:|surfaces:|auth:)/u);
  for (const link of [
    "CLAUDE.md",
    "harness/CLAUDE.md",
    "org/CLAUDE.md",
    "org/agents/smoke/CLAUDE.md",
    "world/CLAUDE.md",
  ]) {
    assert.equal((await lstat(path.join(exampleRoot, link))).isSymbolicLink(), true, link);
  }
});

test("emitted example controller writes evidence and atomically publishes terminal truth", async () => {
  await ensurePublicPackageBuild(packageRoot);
  const root = await mkdtemp(path.join(tmpdir(), "simfile-composed-example-live-"));
  const evidenceRoot = path.join(root, "evidence");
  const bundleRoot = path.join(root, "bundle");
  const runId = "composed-development-controller";
  let controller: { close(): Promise<void> } | undefined;
  const publicWorldArtifact = await import(
    ["simfile", "world-artifact"].join("/")
  ) as typeof import("./index.js");
  const terminalPath = publicWorldArtifact.COMPOSED_WORLD_TERMINAL_ARTIFACT.path;
  try {
    await assert.rejects(lstat(terminalPath), (error: NodeJS.ErrnoException) =>
      error.code === "ENOENT");
    const binding = await import(`${pathToFileURL(
      path.join(exampleRoot, "binding.mjs"),
    ).href}?controller=${Date.now()}`) as {
      composedProjectBinding: { prepareComposedProject(input: unknown): Promise<any> };
    };
    const preparation = await binding.composedProjectBinding.prepareComposedProject({
      base_image_config_digest: digest("a"),
      evidence_root: evidenceRoot,
      internal_port: 4070,
      organization_container_name: "composed-development-controller",
      platform: { architecture: process.arch === "arm64" ? "arm64" : "amd64", os: "linux" },
      run_id: runId,
      secret_root: path.join(root, "secrets"),
      seed: "composed-development-controller-seed",
      simfile_path: simfilePath,
      spawnfile_path: spawnfilePath,
    });
    await extractBundle(preparation.bundle.archive_bytes, bundleRoot);
    const composer = await import(`${pathToFileURL(
      path.join(bundleRoot, "world-artifact", "composer.mjs"),
    ).href}?run=${Date.now()}`) as {
      composeWorldRuntime(): any;
      proveWorldRuntimeReadiness(runtime: unknown): void;
      startWorldRuntime(runtime: unknown, activation: unknown): { close(): Promise<void> };
    };
    const emitted = await import(pathToFileURL(
      path.join(bundleRoot, "world-artifact", "entrypoint.mjs"),
    ).href) as typeof import("./entrypoint.js");
    const runtime = emitted.createWorldRuntime(composer.composeWorldRuntime());
    composer.proveWorldRuntimeReadiness(runtime);
    controller = composer.startWorldRuntime(runtime, { ready: Promise.resolve() });
    const terminalBytes = await readEventually(terminalPath);
    const signal = publicWorldArtifact.parseComposedWorldTerminalSignal(
      JSON.parse(new TextDecoder().decode(terminalBytes)),
    );
    assert.equal(signal.run_id, runId);
    assert.equal(signal.terminal_tick, 4);
    const terminalState = await readFile(
      path.join(evidenceRoot, "projections", "terminal-state.json"),
    );
    assert.equal(signal.outcome_digest,
      `sha256:${createHash("sha256").update(terminalState).digest("hex")}`);
    const world = await import(
      ["simfile", "world"].join("/")
    ) as typeof import("../world/index.js");
    const terminalCheckpoint = world.parseWorldCheckpoint(JSON.parse(await readFile(
      path.join(evidenceRoot, "checkpoints", "terminal.json"), "utf8",
    )) as unknown);
    assert.ok(terminalCheckpoint);
    assert.equal(terminalCheckpoint.dynamics.next_tick, 4);
    for (const artifact of preparation.evidence_artifacts) {
      assert.ok((await readFile(path.join(evidenceRoot, artifact.source))).byteLength >= 0,
        artifact.source);
    }
    const accepted = JSON.parse(await readFile(
      path.join(evidenceRoot, "actions", "accepted-strategic-actions.json"), "utf8",
    )) as { actions: unknown[] };
    assert.deepEqual(accepted.actions, []);
    await controller.close();
    controller = undefined;
  } finally {
    await controller?.close().catch(() => undefined);
    const ownedTerminal = await readFile(terminalPath, "utf8").then((source) => {
      try {
        return publicWorldArtifact.parseComposedWorldTerminalSignal(
          JSON.parse(source),
        ).run_id === runId;
      } catch { return false; }
    }).catch(() => false);
    if (ownedTerminal) await unlink(terminalPath);
    await rm(root, { force: true, recursive: true });
  }
});
