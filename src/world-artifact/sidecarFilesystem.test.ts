import assert from "node:assert/strict";
import { access, mkdtemp, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  closeWorldSidecarRoot,
  commitWorldSidecarEvidence,
  openWorldSidecarRoot,
  readWorldSidecarSecret,
  removeWorldSidecarEvidence,
  watchWorldSidecarActivation,
} from "./sidecarFilesystem.js";

test("secret reader rejects deterministic candidate, scope, and root replacement races", async () => {
  const attempt = async (stage: "before_open" | "before_read", replace: (paths: Readonly<{ readonly root: string; readonly scope: string; readonly secret: string }>) => Promise<void>): Promise<void> => {
    const temporary = await mkdtemp(path.join(os.tmpdir(), "world-sidecar-race-")); const parent = await realpath(temporary);
    const root = path.join(parent, "secrets"); const scope = path.join(root, "runtime"); const secret = path.join(scope, "alpha_token");
    try {
      await mkdir(scope, { recursive: true }); await writeFile(secret, "stable-secret\n");
      const authority = await openWorldSidecarRoot(root, false);
      try {
        await assert.rejects(readWorldSidecarSecret(authority, "runtime", "alpha_token", {
          onStage: async (current) => { if (current === stage) await replace({ root, scope, secret }); },
        }), /filesystem operation failed/u);
      } finally { await closeWorldSidecarRoot(authority); }
    } finally { await rm(parent, { recursive: true, force: true }); }
  };
  await attempt("before_open", async ({ secret }) => {
    const replacement = `${secret}.replacement`; await writeFile(replacement, "replacement-secret\n"); await rename(replacement, secret);
  });
  await attempt("before_read", async ({ secret }) => {
    const replacement = `${secret}.replacement`; await writeFile(replacement, "replacement-secret\n"); await rename(replacement, secret);
  });
  await attempt("before_open", async ({ scope }) => {
    const replacement = `${scope}.replacement`; await rename(scope, replacement); await mkdir(scope); await writeFile(path.join(scope, "alpha_token"), "replacement-secret\n");
  });
  await attempt("before_open", async ({ root }) => {
    const replacement = `${root}.replacement`; await rename(root, replacement); await mkdir(path.join(root, "runtime"), { recursive: true }); await writeFile(path.join(root, "runtime", "alpha_token"), "replacement-secret\n");
  });
});

test("evidence publication is exact-idempotent and removes only its own failed-startup bytes", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "world-sidecar-evidence-"));
  const root = await realpath(temporary);
  const evidenceRoot = path.join(root, "evidence");
  const bytes = new TextEncoder().encode('{"version":"proof-1"}\n');
  const different = new TextEncoder().encode('{"version":"proof-2"}\n');
  const authority = await openWorldSidecarRoot(evidenceRoot, true);
  try {
    assert.equal(await commitWorldSidecarEvidence(authority, bytes), true);
    assert.equal(await commitWorldSidecarEvidence(authority, bytes), false);
    assert.deepEqual(
      await readFile(path.join(evidenceRoot, "world-sidecar.json")),
      Buffer.from(bytes),
    );
    await assert.rejects(
      commitWorldSidecarEvidence(authority, different),
      /filesystem operation failed/u,
    );
    await assert.rejects(
      removeWorldSidecarEvidence(authority, different),
      /filesystem operation failed/u,
    );
    assert.deepEqual(
      await readFile(path.join(evidenceRoot, "world-sidecar.json")),
      Buffer.from(bytes),
    );
    await removeWorldSidecarEvidence(authority, bytes);
    await assert.rejects(access(path.join(evidenceRoot, "world-sidecar.json")));
  } finally {
    await closeWorldSidecarRoot(authority);
    await rm(root, { recursive: true, force: true });
  }
});

test("activation watcher releases only on exact owner marker bytes", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "world-sidecar-activation-"));
  const root = await realpath(temporary);
  const evidenceRoot = path.join(root, "evidence");
  const markerDirectory = path.join(evidenceRoot, ".spawnfile");
  const markerPath = path.join(markerDirectory, "world-service-activated.v1");
  const bundleDigest = `sha256:${"a".repeat(64)}`;
  const requestDigest = `sha256:${"b".repeat(64)}`;
  const receiptDigest = `sha256:${"c".repeat(64)}`;
  const marker = `${JSON.stringify({
    bundle_digest: bundleDigest,
    run_id: "run-1",
    state: "activated",
    topology_receipt_digest: receiptDigest,
    topology_request_digest: requestDigest,
    version: "spawnfile.world-service-activation.v1",
  })}\n`;
  const authority = await openWorldSidecarRoot(evidenceRoot, true);
  try {
    const watcher = watchWorldSidecarActivation(authority, {
      bundle_digest: bundleDigest,
      run_id: "run-1",
    });
    await mkdir(markerDirectory, { mode: 0o755 });
    await writeFile(markerPath, marker, { flag: "wx", mode: 0o644 });
    await watcher.ready;
    await watcher.close();

    await rm(markerPath);
    const rejected = watchWorldSidecarActivation(authority, {
      bundle_digest: bundleDigest,
      run_id: "another-run",
    });
    await writeFile(markerPath, marker, { flag: "wx", mode: 0o644 });
    await assert.rejects(rejected.ready, /activation failed/u);
    await rejected.close();
  } finally {
    await closeWorldSidecarRoot(authority);
    await rm(root, { recursive: true, force: true });
  }
});
