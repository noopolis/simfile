import assert from "node:assert/strict";
import { access, mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { acquireLockedTestPort } from "../test-support/lockedPort.test-helper.js";
import { createDecisionRegistry } from "../world/decisionRegistry.js";
import { readWorldRuntimeClockAuthority } from "../world/clockAuthority.js";
import { runtimeFixture } from "../world/runtime.test-helper.js";
import { startWorldServiceSidecar } from "./entrypoint.js";

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

test("sidecar rejects disposable/live initial-state drift before binding or evidence", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "world-sidecar-readiness-drift-"));
  const root = await realpath(temporary);
  const secretRoot = path.join(root, "secrets");
  const evidenceRoot = path.join(root, "evidence");
  let composition = 0;
  try {
    await mkdir(path.join(secretRoot, "runtime"), { recursive: true });
    await writeFile(path.join(secretRoot, "runtime", "alpha_token"), "alpha-secret\n");
    await assert.rejects(startWorldServiceSidecar({
      runtime_abi: "simfile.world-sidecar-runtime.v1",
      network: { dns_alias: "world", internal_port: 4071 },
      evidence_root: evidenceRoot,
      secret_root: secretRoot,
      bearer_declarations: [{ scope: "runtime", name: "alpha_token", principal: "principal-alpha" }],
      bundle_digest: `sha256:${"c".repeat(64)}`,
    }, () => {
      const fixture = runtimeFixture(false, sidecarRuntimeIdentity);
      composition += 1;
      const decisionRegistry = createDecisionRegistry({
        runId: "run-1",
        worldInstanceId: "instance-1",
        tokenDigestKey: new Uint8Array(32).fill(7),
      });
      if (composition === 2) {
        decisionRegistry.mint({
          principal: "principal-alpha",
          issuedTick: 0,
          validThroughTick: 1,
        });
      }
      return {
        dynamics: fixture.dynamics,
        surfaceRegistry: fixture.surfaceRegistry,
        capabilityManifests: fixture.capabilityManifests,
        boundGrants: fixture.boundGrants,
        decisionRegistry,
        readLedger: fixture.readLedger,
      };
    }, undefined, () => {}), /startup failed/u);
    await assert.rejects(access(evidenceRoot));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("sidecar rejects a readiness callback that mutates its disposable world", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "world-sidecar-mutating-proof-"));
  const root = await realpath(temporary);
  const secretRoot = path.join(root, "secrets");
  const evidenceRoot = path.join(root, "evidence");
  try {
    await mkdir(path.join(secretRoot, "runtime"), { recursive: true });
    await writeFile(path.join(secretRoot, "runtime", "alpha_token"), "alpha-secret\n");
    await assert.rejects(startWorldServiceSidecar({
      runtime_abi: "simfile.world-sidecar-runtime.v1",
      network: { dns_alias: "world", internal_port: 4070 },
      evidence_root: evidenceRoot,
      secret_root: secretRoot,
      bearer_declarations: [{
        scope: "runtime",
        name: "alpha_token",
        principal: "principal-alpha",
      }],
      bundle_digest: `sha256:${"e".repeat(64)}`,
    }, () => {
      const fixture = runtimeFixture(false, sidecarRuntimeIdentity);
      return {
        dynamics: fixture.dynamics,
        surfaceRegistry: fixture.surfaceRegistry,
        capabilityManifests: fixture.capabilityManifests,
        boundGrants: fixture.boundGrants,
        decisionRegistry: pristineDecisionRegistry(),
        readLedger: fixture.readLedger,
      };
    }, undefined, (runtime) => {
      readWorldRuntimeClockAuthority(runtime)!.stepDynamics();
    }), /startup failed/u);
    await assert.rejects(access(evidenceRoot));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("sidecar rejects symlink secrets and never commits evidence before a successful bind", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "world-sidecar-hostile-")); const root = await realpath(temporary);
  const secretRoot = path.join(root, "secrets"); const evidenceRoot = path.join(root, "evidence"); const external = path.join(root, "external");
  await mkdir(secretRoot); await writeFile(external, "external-secret\n"); await symlink(external, path.join(secretRoot, "runtime"));
  const configuration = (internalPort: number) => ({ runtime_abi: "simfile.world-sidecar-runtime.v1", network: { dns_alias: "world", internal_port: internalPort }, evidence_root: evidenceRoot, secret_root: secretRoot, bearer_declarations: [{ scope: "runtime", name: "alpha_token", principal: "principal-alpha" }], bundle_digest: "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc" });
  try {
    const rejectedLease = await acquireLockedTestPort();
    try { await assert.rejects(startWorldServiceSidecar(configuration(rejectedLease.port), () => { throw new Error("unreachable"); }), /startup failed|filesystem operation failed/u); }
    finally { await rejectedLease.release(); }
    await assert.rejects(access(evidenceRoot));
    await rm(path.join(secretRoot, "runtime")); await mkdir(path.join(secretRoot, "runtime")); await writeFile(path.join(secretRoot, "runtime", "alpha_token"), "alpha-secret\n");
    const occupiedLease = await acquireLockedTestPort(); const occupiedPort = occupiedLease.port; const blocker = createServer();
    await new Promise<void>((resolve, reject) => { blocker.once("error", reject); blocker.listen(occupiedPort, "0.0.0.0", resolve); });
    try {
      const fixture = runtimeFixture(false, sidecarRuntimeIdentity);
      await assert.rejects(startWorldServiceSidecar(configuration(occupiedPort), () => ({ dynamics: fixture.dynamics, surfaceRegistry: fixture.surfaceRegistry, capabilityManifests: fixture.capabilityManifests, boundGrants: fixture.boundGrants, decisionRegistry: pristineDecisionRegistry(), readLedger: fixture.readLedger })), /startup failed/u);
      await assert.rejects(access(path.join(evidenceRoot, "world-sidecar.json")));
    } finally { await new Promise<void>((resolve) => blocker.close(() => resolve())); await occupiedLease.release(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("sidecar startup evidence is idempotent and a failed retry cannot delete prior evidence", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "world-sidecar-retry-"));
  const root = await realpath(temporary);
  const secretRoot = path.join(root, "secrets");
  const evidenceRoot = path.join(root, "evidence");
  const portLease = await acquireLockedTestPort();
  const configuration = {
    runtime_abi: "simfile.world-sidecar-runtime.v1",
    network: { dns_alias: "world", internal_port: portLease.port },
    evidence_root: evidenceRoot,
    secret_root: secretRoot,
    bearer_declarations: [{
      scope: "runtime",
      name: "alpha_token",
      principal: "principal-alpha",
    }],
    bundle_digest: `sha256:${"d".repeat(64)}`,
  };
  const compose = () => {
    const fixture = runtimeFixture(false, sidecarRuntimeIdentity);
    return {
      dynamics: fixture.dynamics,
      surfaceRegistry: fixture.surfaceRegistry,
      capabilityManifests: fixture.capabilityManifests,
      boundGrants: fixture.boundGrants,
      decisionRegistry: pristineDecisionRegistry(),
      readLedger: fixture.readLedger,
    };
  };
  try {
    await mkdir(path.join(secretRoot, "runtime"), { recursive: true });
    await writeFile(path.join(secretRoot, "runtime", "alpha_token"), "alpha-secret\n");
    const first = await startWorldServiceSidecar(configuration, compose);
    await first.close();
    const evidencePath = path.join(evidenceRoot, "world-sidecar.json");
    const exact = await readFile(evidencePath);

    const blocker = createServer();
    await new Promise<void>((resolve, reject) => {
      blocker.once("error", reject);
      blocker.listen(portLease.port, "0.0.0.0", resolve);
    });
    try {
      await assert.rejects(
        startWorldServiceSidecar(configuration, compose),
        /startup failed/u,
      );
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
    }
    assert.deepEqual(await readFile(evidencePath), exact);

    const retried = await startWorldServiceSidecar(configuration, compose);
    await retried.close();
    assert.deepEqual(await readFile(evidencePath), exact);
  } finally {
    await portLease.release();
    await rm(root, { recursive: true, force: true });
  }
});

test("sidecar configuration rejects accessors without invoking them or composition", async () => {
  let accesses = 0; let compositions = 0;
  const hostile = {
    runtime_abi: "simfile.world-sidecar-runtime.v1",
    network: { dns_alias: "world", internal_port: 4070 },
    evidence_root: "/run/simfile/evidence",
    secret_root: "/run/secrets",
    bearer_declarations: [{ scope: "runtime", name: "alpha_token", principal: "principal:alpha" }],
    bundle_digest: "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
  };
  Object.defineProperty(hostile, "secret_root", { enumerable: true, get: () => { accesses += 1; return "/run/secrets"; } });
  await assert.rejects(startWorldServiceSidecar(hostile, () => { compositions += 1; return {} as never; }), /invalid world service entrypoint configuration/u);
  assert.equal(accesses, 0); assert.equal(compositions, 0);
});

test("sidecar configuration requires the same canonical scoped-secret order as the bundle", async () => {
  let compositions = 0;
  await assert.rejects(startWorldServiceSidecar({
    runtime_abi: "simfile.world-sidecar-runtime.v1", network: { dns_alias: "world", internal_port: 4070 },
    evidence_root: "/run/simfile/evidence", secret_root: "/run/secrets",
    bearer_declarations: [{ scope: "runtime", name: "beta_token", principal: "principal:beta" }, { scope: "runtime", name: "alpha_token", principal: "principal:alpha" }],
    bundle_digest: "sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
  }, () => { compositions += 1; return {} as never; }), /invalid world service entrypoint configuration/u);
  assert.equal(compositions, 0);
});
