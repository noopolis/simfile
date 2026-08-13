import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, lstat, mkdtemp, mkdir, readFile, realpath, stat, symlink, writeFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { acquireLockedTestPort } from "../test-support/lockedPort.test-helper.js";
import { runtimeFixture } from "../world/runtime.test-helper.js";
import { canonicalJson } from "../dynamics/buildIdentity.js";
import { createDecisionRegistry } from "../world/decisionRegistry.js";
import { WORLD_DECISION_CLAIM_CAPABILITY } from "../world/decisionClaim.js";
import { readWorldRuntimeClockAuthority } from "../world/clockAuthority.js";
import { createWorldServiceArtifact, createWorldServiceContract } from "./artifact.js";
import { startWorldServiceSidecar } from "./entrypoint.js";
import { createRunnableWorldSidecarBundle, parseRunnableWorldComposerProvenance, parseRunnableWorldSidecarManifest, redactWorldSidecarError, RUNNABLE_WORLD_SIDECAR_ARCHIVE_PATHS } from "./runnableBundle.js";
import { parseWorldSidecarAbsolutePath } from "./sidecarPath.js";

const contract = createWorldServiceContract({ dynamics_provider: "d", world_surface: "s", capability_manifest: "c", world_act_request: "a", world_checkpoint: "k", world_runtime: "r", handler: "h", adapters: { json: "j", mcp: "m" }, operations: ["status"], spawnfile_receipts: ["receipt"], world_bindings: "b" });
let sealedArtifact: ReturnType<typeof createWorldServiceArtifact> | undefined;
const artifact = async () => {
  sealedArtifact ??= createWorldServiceArtifact({ source_root: process.cwd(), dependency_root: process.cwd(), contract });
  return sealedArtifact;
};
const composerBytes = new TextEncoder().encode("export const composeWorldRuntime = () => undefined;\n");
const composerUnsigned = Object.freeze({
  version: "simfile.world-composer-build.v1" as const,
  tool: Object.freeze({ name: "esbuild" as const, version: "0.25.0", closure_digest: "sha256:" + "4".repeat(64) }),
  config: Object.freeze({ absWorkingDir: "source_root", bundle: true, charset: "utf8", defines: Object.freeze({ build_receipt_sha256: "sha256:" + "1".repeat(64), config_sha256: "sha256:" + "2".repeat(64), provenance_sha256: "sha256:" + "3".repeat(64) }), entryPoint: "fixture/composer.ts", external: Object.freeze(["./entrypoint.mjs", "./provider.mjs"]), format: "esm", legalComments: "none", metafile: true, platform: "node", sourceSnapshot: true, sourcemap: false, target: "node22", write: false }),
  source_graph: Object.freeze([{ path: "fixture/composer.ts", bytes: composerBytes.byteLength, sha256: `sha256:${createHash("sha256").update(composerBytes).digest("hex")}` }]),
});
const composerProvenance = parseRunnableWorldComposerProvenance({ ...composerUnsigned, digest: `sha256:${createHash("sha256").update(canonicalJson({ domain: "simfile.world-composer-build.v1", value: composerUnsigned })).digest("hex")}` });
const declarations = Object.freeze([{ scope: "runtime", name: "alpha_token", principal: "principal:alpha" }, { scope: "runtime", name: "beta_token", principal: "principal:beta" }]);
const sidecarRuntimeIdentity = Object.freeze({
  runId: "run-1",
  worldInstanceId: "instance-1",
  buildReceiptSha256: "2".repeat(64),
});
const pristineDecisionRegistry = () => createDecisionRegistry({
  runId: sidecarRuntimeIdentity.runId,
  worldInstanceId: sidecarRuntimeIdentity.worldInstanceId,
  tokenDigestKey: new Uint8Array(32).fill(7),
});
const input = async () => ({ artifact: await artifact(), composer_bytes: composerBytes, composer_provenance: composerProvenance, provider_bytes: new TextEncoder().encode("export const createDynamicsProvider = () => undefined;\n"), network: { dns_alias: "world", internal_port: 4070 }, evidence_root: "/var/lib/simfile/evidence", secrets: { root: "/run/simfile-secrets", declarations } });
const tarNames = (bytes: readonly number[]): string[] => {
  const archive = Uint8Array.from(bytes); const output: string[] = []; let offset = 0;
  while (offset + 512 <= archive.byteLength && archive[offset] !== 0) {
    const header = archive.subarray(offset, offset + 512); const nul = header.indexOf(0); const name = new TextDecoder().decode(header.subarray(0, nul));
    const rawSize = new TextDecoder().decode(header.subarray(124, 136)).replace(/\0.*$/u, "").trim(); const size = Number.parseInt(rawSize, 8);
    assert.equal(header[156], 0x30); assert.equal(Number.isSafeInteger(size), true); output.push(name);
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  assert.equal(offset + 1024, archive.byteLength); return output;
};
test("runnable sidecar bundle has deterministic canonical bytes and an exact file-only allowlist", async () => {
  const first = await createRunnableWorldSidecarBundle(await input()); const second = await createRunnableWorldSidecarBundle(await input());
  assert.deepEqual(first, second); assert.deepEqual(tarNames(first.archive_bytes), [...RUNNABLE_WORLD_SIDECAR_ARCHIVE_PATHS]);
  const differentRoot = await createRunnableWorldSidecarBundle({ ...await input(), secrets: { root: "/run/other-secrets", declarations } });
  assert.notEqual(differentRoot.manifest.digest, first.manifest.digest);
  assert.notEqual(differentRoot.archive_sha256, first.archive_sha256);
  assert.deepEqual(parseRunnableWorldSidecarManifest(JSON.parse(new TextDecoder().decode(Uint8Array.from(first.manifest_bytes)))), first.manifest);
  assert.throws(() => parseRunnableWorldSidecarManifest({ ...first.manifest, network: { ...first.manifest.network, internal_port: 4071 } }), /invalid runnable/u);
  assert.throws(() => parseRunnableWorldSidecarManifest({ ...first.manifest, secrets: { ...first.manifest.secrets, declarations: [...first.manifest.secrets.declarations].reverse() } }), /invalid runnable/u);
  assert.throws(() => parseRunnableWorldSidecarManifest({ ...first.manifest, artifact: { ...first.manifest.artifact, manifest_file: { ...first.manifest.artifact.manifest_file, bytes: first.manifest.artifact.manifest_file.bytes + 1 } } }), /invalid runnable/u);
  assert.throws(() => parseRunnableWorldSidecarManifest({ ...first.manifest, provider: { ...first.manifest.provider, sha256: "sha256:" + "0".repeat(64) } }), /invalid runnable/u);
  for (const declaration of [
    { scope: "../runtime", name: "alpha_token", principal: "principal:alpha" },
    { scope: ".", name: "alpha_token", principal: "principal:alpha" },
    { scope: "runtime", name: "/alpha_token", principal: "principal:alpha" },
    { scope: "runtime", name: "..", principal: "principal:alpha" },
    { scope: "runtime", name: "alpha.token", principal: "principal:alpha" },
  ]) await assert.rejects(createRunnableWorldSidecarBundle({ ...await input(), secrets: { root: "/run/simfile-secrets", declarations: [declaration] } }), /invalid runnable/u);
  const baseline = await input();
  await assert.rejects(createRunnableWorldSidecarBundle({ ...baseline, secrets: { ...baseline.secrets, declarations: [baseline.secrets.declarations[0]!, { ...baseline.secrets.declarations[0]!, principal: "agent:other" }] } }), /invalid runnable/u);
  await assert.rejects(createRunnableWorldSidecarBundle({ ...baseline, secrets: { ...baseline.secrets, declarations: [baseline.secrets.declarations[0]!, { scope: "world", name: "other_bearer", principal: baseline.secrets.declarations[0]!.principal }] } }), /invalid runnable/u);
});

test("bundle sealing rejects altered artifact, manifest, provenance, and noncanonical roots", async () => {
  const baseline = await input();
  const changedArtifact = structuredClone(baseline.artifact) as unknown as { artifact_bytes: number[] };
  changedArtifact.artifact_bytes[changedArtifact.artifact_bytes.length - 1] ^= 1;
  await assert.rejects(createRunnableWorldSidecarBundle({ ...baseline, artifact: changedArtifact as never }), /invalid runnable/u);
  const changedManifest = structuredClone(baseline.artifact) as unknown as { manifest_bytes: number[] };
  changedManifest.manifest_bytes[0] ^= 1;
  await assert.rejects(createRunnableWorldSidecarBundle({ ...baseline, artifact: changedManifest as never }), /invalid runnable/u);
  const forgedProvenance = structuredClone(composerProvenance) as unknown as { source_graph: Array<{ bytes: number }> };
  forgedProvenance.source_graph[0].bytes += 1;
  await assert.rejects(createRunnableWorldSidecarBundle({ ...baseline, composer_provenance: forgedProvenance as never }), /invalid runnable/u);
  for (const root of ["/", "/tmp/../tmp/evidence", "/tmp//evidence", "/tmp/./evidence", "/tmp/evidence/tmp", "relative/evidence", "/tmp/evidence\n"]) {
    assert.throws(() => parseWorldSidecarAbsolutePath(root), /invalid world sidecar path/u);
    await assert.rejects(createRunnableWorldSidecarBundle({ ...baseline, evidence_root: root }), /invalid runnable/u);
    await assert.rejects(createRunnableWorldSidecarBundle({ ...baseline, secrets: { ...baseline.secrets, root } }), /invalid runnable/u);
  }
  const bundle = await createRunnableWorldSidecarBundle(baseline);
  assert.throws(() => parseRunnableWorldSidecarManifest({ ...bundle.manifest, secrets: { root: "/run//secrets", declarations: baseline.secrets.declarations } }), /invalid runnable/u);
});

test("secret binding manifest is exact and rejects hostile roots without invoking them", async () => {
  const baseline = await input(); let accesses = 0;
  const hostile = { root: "/run/simfile-secrets", declarations };
  Object.defineProperty(hostile, "root", { enumerable: true, get: () => { accesses += 1; return "/run/simfile-secrets"; } });
  await assert.rejects(createRunnableWorldSidecarBundle({ ...baseline, secrets: hostile }), /invalid runnable/u);
  assert.equal(accesses, 0);
  await assert.rejects(createRunnableWorldSidecarBundle({ ...baseline, secrets: { ...baseline.secrets, extra: true } as never }), /invalid runnable/u);
  await assert.rejects(createRunnableWorldSidecarBundle({ ...baseline, secrets: { declarations } } as never), /invalid runnable/u);
});

test("sidecar diagnostics preserve secret paths while redacting values and bare digests", () => {
  const missing = "ENOENT: no such file or directory, open '/run/spawnfile-secrets/world/runtime_config'";
  assert.equal(redactWorldSidecarError(missing), missing);
  assert.equal(
    redactWorldSidecarError("token=live-bearer-value authorization=another-live-value"),
    "token=[redacted] authorization=[redacted]",
  );
  assert.equal(redactWorldSidecarError(`digest ${"a".repeat(32)}`), "digest [redacted]");
  const filename = `/run/spawnfile-secrets/${"a".repeat(32)}`;
  assert.equal(redactWorldSidecarError(filename), filename);
});

test("sidecar resolves bearer values only from mounted files, routes one server, and closes cleanly", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "world-sidecar-")); const root = await realpath(temporary); const secretRoot = path.join(root, "secrets"); const evidenceRoot = path.join(root, "evidence");
  const fixture = runtimeFixture(false, sidecarRuntimeIdentity); const portLease = await acquireLockedTestPort(); const internalPort = portLease.port;
  try {
    await mkdir(path.join(secretRoot, "runtime"), { recursive: true }); await writeFile(path.join(secretRoot, "runtime", "alpha_token"), "alpha-secret\n"); await writeFile(path.join(secretRoot, "runtime", "beta_token"), "beta-secret\n");
    const sidecar = await startWorldServiceSidecar({ runtime_abi: "simfile.world-sidecar-runtime.v1", network: { dns_alias: "world", internal_port: internalPort }, evidence_root: evidenceRoot, secret_root: secretRoot, bearer_declarations: [{ scope: "runtime", name: "alpha_token", principal: "principal-alpha" }, { scope: "runtime", name: "beta_token", principal: "principal-beta" }], bundle_digest: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" }, () => ({ dynamics: fixture.dynamics, surfaceRegistry: fixture.surfaceRegistry, capabilityManifests: fixture.capabilityManifests, boundGrants: fixture.boundGrants, decisionRegistry: pristineDecisionRegistry(), readLedger: fixture.readLedger }));
    const ready = await fetch(`http://127.0.0.1:${internalPort}/readyz`); assert.equal(ready.status, 200); assert.deepEqual(await ready.json(), { status: "ready" });
    const readinessResponse = await fetch(
      `http://127.0.0.1:${internalPort}/v1/world/readiness`,
    );
    assert.equal(readinessResponse.status, 200);
    const readiness = await readinessResponse.json() as Record<string, unknown>;
    assert.equal(readiness.version, "simfile.world-sidecar-readiness.v1");
    assert.equal(readiness.runtime_abi, "simfile.world-sidecar-runtime.v1");
    assert.equal(readiness.run_id, "run-1");
    assert.equal(readiness.world_instance_id, "instance-1");
    assert.equal(readiness.artifact_digest, null);
    assert.deepEqual(readiness.clock, { state: "paused", next_tick: 0 });
    assert.deepEqual(readiness.decisions, { phase: "open", count: 0 });
    assert.equal((readiness.capability_manifest_digests as unknown[]).length, 2);
    const world = await fetch(`http://127.0.0.1:${internalPort}/v1/world/status`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }); assert.equal(world.status, 401);
    const mcp = await fetch(`http://127.0.0.1:${internalPort}/mcp`, { method: "POST" }); assert.equal(mcp.status, 401);
    const evidencePath = path.join(evidenceRoot, "world-sidecar.json");
    assert.equal((await stat(evidencePath)).mode & 0o777, 0o644);
    const evidence = JSON.parse(await readFile(evidencePath, "utf8")) as Record<string, unknown>;
    assert.equal(evidence.bundle_digest, "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
    assert.equal(evidence.version, "simfile.world-sidecar-readiness.v1");
    assert.equal(evidence.runtime_abi, "simfile.world-sidecar-runtime.v1");
    assert.match(String(evidence.mechanics_sha256), /^sha256:[a-f0-9]{64}$/u);
    assert.match(String(evidence.normalized_checkpoint_sha256), /^sha256:[a-f0-9]{64}$/u);
    await sidecar.close(); await sidecar.close(); assert.equal(sidecar.server.listening, false);
  } finally { await portLease.release(); await rm(root, { recursive: true, force: true }); }
});

test("sidecar proves one disposable same-factory world and activates live state only after the owner marker", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "world-sidecar-readiness-"));
  const root = await realpath(temporary);
  const secretRoot = path.join(root, "secrets");
  const evidenceRoot = path.join(root, "evidence");
  const portLease = await acquireLockedTestPort();
  let compositions = 0;
  let proofs = 0;
  let activations = 0;
  let activationSeen: Promise<void> | undefined;
  let liveDynamics: ReturnType<typeof runtimeFixture>["dynamics"] | undefined;
  try {
    await mkdir(path.join(secretRoot, "runtime"), { recursive: true });
    await writeFile(path.join(secretRoot, "runtime", "alpha_token"), "alpha-secret\n");
    const compose = () => {
      compositions += 1;
      const fixture = runtimeFixture(false, { ...sidecarRuntimeIdentity,
        redPrincipal: "principal-alpha" });
      if (compositions === 2) liveDynamics = fixture.dynamics;
      return {
        dynamics: fixture.dynamics,
        surfaceRegistry: fixture.surfaceRegistry,
        capabilityManifests: fixture.capabilityManifests,
        boundGrants: fixture.boundGrants,
        decisionRegistry: createDecisionRegistry({
          runId: "run-1",
          worldInstanceId: "instance-1",
          tokenDigestKey: new Uint8Array(32).fill(7),
        }),
        readLedger: fixture.readLedger,
      };
    };
    const sidecar = await startWorldServiceSidecar({
      runtime_abi: "simfile.world-sidecar-runtime.v1",
      network: { dns_alias: "world", internal_port: portLease.port },
      evidence_root: evidenceRoot,
      secret_root: secretRoot,
      bearer_declarations: [{ scope: "runtime", name: "alpha_token", principal: "principal-alpha" }],
      bundle_digest: `sha256:${"b".repeat(64)}`,
      activation_bundle_digest: `sha256:${"a".repeat(64)}`,
    }, compose, async (runtime, activation) => {
      // The production data-network socket must not exist while the
      // controller is being prepared.
      await assert.rejects(fetch(
        `http://127.0.0.1:${portLease.port}/readyz`,
        { signal: AbortSignal.timeout(250) },
      ));
      activationSeen = activation.ready.then(() => {
        readWorldRuntimeClockAuthority(runtime)!.stepDynamics();
        activations += 1;
      });
      assert.equal(activations, 0);
      return Object.freeze({ close: async () => {} });
    }, (disposableRuntime) => {
      proofs += 1;
      assert.notEqual(disposableRuntime, null);
    }, [WORLD_DECISION_CLAIM_CAPABILITY]);
    assert.equal(compositions, 2);
    assert.equal(proofs, 1);
    assert.equal(activations, 0);
    assert.equal(liveDynamics?.nextTick, 0);
    assert.equal((await fetch(`http://127.0.0.1:${portLease.port}/readyz`)).status, 200);
    const advertised = await (await fetch(
      `http://127.0.0.1:${portLease.port}/v1/world/readiness`,
    )).json() as { capabilities?: Array<{ identity: string }> };
    assert.deepEqual(advertised.capabilities?.map((item) => item.identity),
      [WORLD_DECISION_CLAIM_CAPABILITY]);
    const claim = (body: unknown) => fetch(
      `http://127.0.0.1:${portLease.port}/v1/world/claim`, {
        method: "POST",
        headers: { authorization: "Bearer alpha-secret",
          "content-type": "application/json" },
        body: JSON.stringify(body),
      },
    );
    const claimBody = { request_id: "sidecar-claim-1",
      wake_id: "sidecar-schedule-alpha-1" };
    assert.equal((await claim(claimBody)).status, 403);
    assert.equal((await fetch(
      `http://127.0.0.1:${portLease.port}/v1/world/clock`,
    )).status, 409);
    await mkdir(path.join(evidenceRoot, ".spawnfile"), { mode: 0o755 });
    await writeFile(path.join(evidenceRoot, ".spawnfile", "world-service-activated.v1"), `${JSON.stringify({
      bundle_digest: `sha256:${"a".repeat(64)}`,
      run_id: "run-1",
      state: "activated",
      topology_receipt_digest: `sha256:${"c".repeat(64)}`,
      topology_request_digest: `sha256:${"d".repeat(64)}`,
      version: "spawnfile.world-service-activation.v1",
    })}\n`, { mode: 0o644 });
    await activationSeen;
    assert.equal(activations, 1);
    const claimedResponse = await claim(claimBody);
    assert.equal(claimedResponse.status, 200);
    const claimed = await claimedResponse.json() as { decision_token: string };
    assert.equal((await fetch(
      `http://127.0.0.1:${portLease.port}/v1/world/status`, {
        method: "POST",
        headers: { authorization: "Bearer alpha-secret",
          "content-type": "application/json" },
        body: JSON.stringify({ decision_token: claimed.decision_token }),
      },
    )).status, 200);
    assert.equal((await claim(claimBody)).status, 403);
    const clock = await fetch(`http://127.0.0.1:${portLease.port}/v1/world/clock`);
    assert.equal(clock.status, 200);
    assert.deepEqual(await clock.json(), {
      action_count: 0,
      clock: { completed_tick: 1, next_tick: 2, state: "running" },
      run_id: "run-1",
      version: "simfile.world-sidecar-clock.v1",
      world_instance_id: "instance-1",
    });
    await sidecar.close();
  } finally {
    await portLease.release();
    await rm(root, { recursive: true, force: true });
  }
});
