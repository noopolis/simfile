import assert from "node:assert/strict";
import {
  access,
  chmod,
  lstat,
  mkdir,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile
} from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  createBuildLoadFixture,
  preparedWithBody
} from "./buildLoad.test-helper.js";

const assertMissing = async (fileName: string): Promise<void> => {
  await assert.rejects(() => access(fileName), { code: "ENOENT" });
};

test("persists exact read-only content-addressed bytes, imports only the artifact, copies evidence, and cleans idempotently", async (t) => {
  const marker = "__simfileBuildLoadFactoryInvoked";
  t.after(() => { delete (globalThis as Record<string, unknown>)[marker]; });
  const fixture = await createBuildLoadFixture(t, [
    "export const artifactOnly = 37;",
    `export const createDynamicsProvider = () => { globalThis.${marker} = true; return {}; };`
  ].join("\n"));
  const lifecycle = await fixture.persist();
  const expectedArtifact = path.join(
    fixture.scratchRoot,
    "dynamics",
    `sha256-${fixture.prepared.artifactSha256}`,
    "provider.mjs"
  );
  const expectedReceipt = path.join(fixture.scratchRoot, "dynamics", "build-receipt.json");
  assert.equal(lifecycle.artifactPath, expectedArtifact);
  assert.equal(lifecycle.receiptPath, expectedReceipt);
  assert.deepEqual([...await readFile(expectedArtifact)], fixture.prepared.artifactBytes);
  assert.deepEqual([...await readFile(expectedReceipt)], fixture.receipt.receiptBytes);
  assert.equal((await lstat(expectedArtifact)).mode & 0o222, 0);
  assert.equal((await lstat(expectedReceipt)).mode & 0o222, 0);

  const imported = await lifecycle.importArtifact();
  assert.equal(imported.artifactOnly, 37);
  assert.equal(imported.value, undefined);
  assert.equal(typeof imported.createDynamicsProvider, "function");
  assert.equal((globalThis as Record<string, unknown>)[marker], undefined);
  assert.deepEqual(
    [...await readFile(lifecycle.evidence?.artifactPath ?? "")],
    fixture.prepared.artifactBytes
  );
  assert.deepEqual(
    [...await readFile(lifecycle.evidence?.receiptPath ?? "")],
    fixture.receipt.receiptBytes
  );
  assert.equal((await lstat(lifecycle.evidence?.artifactPath ?? "")).mode & 0o222, 0);
  assert.equal((await lstat(lifecycle.evidence?.receiptPath ?? "")).mode & 0o222, 0);

  await lifecycle.cleanup();
  await lifecycle.cleanup();
  await assertMissing(expectedArtifact);
  await assertMissing(expectedReceipt);
});

test("rejects missing, malformed, mismatched, and wrongly addressed receipts or artifacts", async (t) => {
  const fixture = await createBuildLoadFixture(t);
  await assert.rejects(() => fixture.persist({ receipt: undefined }), /receipt is missing or malformed/u);
  await assert.rejects(
    () => fixture.persist({
      receipt: {
        ...fixture.receipt,
        receiptSha256: "0".repeat(64)
      }
    }),
    /bytes\/hash mismatch/u
  );
  await assert.rejects(
    () => fixture.persist({
      receipt: {
        ...fixture.receipt,
        payload: {
          ...fixture.receipt.payload,
          artifact_path: "./dynamics/sha256-deadbeef/provider.mjs"
        }
      }
    }),
    /payload mismatch/u
  );
  await assert.rejects(
    () => fixture.persist({
      prepared: {
        ...fixture.prepared,
        artifactBytes: [...fixture.prepared.artifactBytes, 0]
      }
    }),
    /artifact SHA mismatch/u
  );
  await assertMissing(path.join(fixture.scratchRoot, "dynamics"));
});

test("rejects non-absolute and overlapping roots including dot-dot-prefixed child names", async (t) => {
  const fixture = await createBuildLoadFixture(t);
  await assert.rejects(() => fixture.persist({ scratchRoot: "relative" }), /must be absolute/u);
  const deceptiveChild = path.join(fixture.scratchRoot, "..evil");
  await mkdir(deceptiveChild);
  await assert.rejects(
    () => fixture.persist({ evidenceRoot: deceptiveChild }),
    /must not overlap/u
  );
  await assertMissing(path.join(fixture.scratchRoot, "dynamics"));
});

test("fails closed on missing or mutated persisted artifact and receipt", async (t) => {
  const fixture = await createBuildLoadFixture(t);
  for (const target of ["artifact", "receipt"] as const) {
    const lifecycle = await fixture.persist();
    const fileName = target === "artifact" ? lifecycle.artifactPath : lifecycle.receiptPath;
    await chmod(fileName, 0o600);
    await writeFile(fileName, "hostile mutation\n");
    await assert.rejects(() => lifecycle.verify(), /read-only|bytes mismatch/u);
    await lifecycle.cleanup();
  }

  const lifecycle = await fixture.persist();
  await rm(lifecycle.receiptPath);
  await assert.rejects(() => lifecycle.verify(), /receipt is missing/u);
  await lifecycle.cleanup();

  const missingArtifact = await fixture.persist();
  await rm(missingArtifact.artifactPath);
  await assert.rejects(() => missingArtifact.verify(), /artifact is missing/u);
  await missingArtifact.cleanup();
});

test("source drift after persistence fails before artifact top-level evaluation", async (t) => {
  const marker = "__simfileBuildLoadSourceDrift";
  const fixture = await createBuildLoadFixture(
    t,
    `globalThis.${marker} = true;\nexport const createDynamicsProvider = () => ({});\n`
  );
  t.after(() => { delete (globalThis as Record<string, unknown>)[marker]; });
  const lifecycle = await fixture.persist();
  await writeFile(fixture.sourcePath, "export const value = 2;\n");
  await assert.rejects(
    () => lifecycle.importArtifact(),
    /prepared project descriptor mismatch/u
  );
  assert.equal((globalThis as Record<string, unknown>)[marker], undefined);
  await assertMissing(lifecycle.artifactPath);
});

const mutatingArtifactBodies = {
  artifact: [
    'import { chmodSync, writeFileSync } from "node:fs";',
    'import { fileURLToPath } from "node:url";',
    "const target = fileURLToPath(import.meta.url);",
    "chmodSync(target, 0o600);",
    'writeFileSync(target, "mutated artifact\\n");',
    "export const createDynamicsProvider = () => ({});"
  ].join("\n"),
  receipt: [
    'import { chmodSync, writeFileSync } from "node:fs";',
    'import { fileURLToPath } from "node:url";',
    'const target = fileURLToPath(new URL("../build-receipt.json", import.meta.url));',
    "chmodSync(target, 0o600);",
    'writeFileSync(target, "mutated receipt\\n");',
    "export const createDynamicsProvider = () => ({});"
  ].join("\n")
} as const;

for (const [target, body] of Object.entries(mutatingArtifactBodies)) {
  test(`detects ${target} mutation during top-level import before returning a factory`, async (t) => {
    const fixture = await createBuildLoadFixture(t, `${body}\n`);
    const lifecycle = await fixture.persist();
    await assert.rejects(
      () => lifecycle.importArtifact(),
      /read-only|bytes mismatch/u
    );
    await assertMissing(lifecycle.artifactPath);
    assert.deepEqual(
      [...await readFile(lifecycle.evidence?.artifactPath ?? "")],
      fixture.prepared.artifactBytes
    );
    assert.deepEqual(
      [...await readFile(lifecycle.evidence?.receiptPath ?? "")],
      fixture.receipt.receiptBytes
    );
  });
}

test("detects authored-source mutation during top-level import before returning exports", async (t) => {
  const environmentKey = "SIMFILE_BUILD_LOAD_MUTATE_SOURCE";
  const previous = process.env[environmentKey];
  t.after(() => {
    if (previous === undefined) delete process.env[environmentKey];
    else process.env[environmentKey] = previous;
  });
  const fixture = await createBuildLoadFixture(t, [
    'import { writeFileSync } from "node:fs";',
    `const source = process.env.${environmentKey};`,
    'if (!source) throw new Error("missing mutation source");',
    'writeFileSync(source, "export const drifted = true;\\n");',
    "export const createDynamicsProvider = () => ({});"
  ].join("\n"));
  process.env[environmentKey] = fixture.sourcePath;
  const lifecycle = await fixture.persist();
  await assert.rejects(
    () => lifecycle.importArtifact(),
    /prepared project descriptor mismatch/u
  );
  await assertMissing(lifecycle.artifactPath);
  assert.ok(lifecycle.evidence);
});

test("preserves a verified evidence pair when artifact evaluation throws and cleans scratch", async (t) => {
  const fixture = await createBuildLoadFixture(t, 'throw new Error("fixture import failure");\n');
  const lifecycle = await fixture.persist();
  await assert.rejects(() => lifecycle.importArtifact(), /fixture import failure/u);
  await assertMissing(lifecycle.artifactPath);
  const evidence = lifecycle.evidence;
  assert.ok(evidence);
  assert.deepEqual([...await readFile(evidence.artifactPath)], fixture.prepared.artifactBytes);
  assert.deepEqual([...await readFile(evidence.receiptPath)], fixture.receipt.receiptBytes);
});

test("evidence copy failure preserves caller bytes and leaves no partial artifact or temp", async (t) => {
  const fixture = await createBuildLoadFixture(t);
  const lifecycle = await fixture.persist();
  const evidenceDynamics = path.join(fixture.evidenceRoot, "dynamics");
  const evidenceReceipt = path.join(evidenceDynamics, "build-receipt.json");
  await mkdir(evidenceDynamics);
  await writeFile(evidenceReceipt, "caller sentinel\n");
  await assert.rejects(() => lifecycle.copyEvidence(), /target already exists/u);
  assert.equal(await readFile(evidenceReceipt, "utf8"), "caller sentinel\n");
  assert.deepEqual(await readdir(evidenceDynamics), ["build-receipt.json"]);
  await lifecycle.verify();
  await lifecycle.cleanup();
});

test("cleanup failure remains retryable and removes only lifecycle-owned paths", async (t) => {
  const fixture = await createBuildLoadFixture(t);
  const lifecycle = await fixture.persist();
  const artifactDirectory = path.dirname(lifecycle.artifactPath);
  const blocker = path.join(artifactDirectory, "caller-blocker");
  await writeFile(blocker, "block cleanup\n");
  await assert.rejects(() => lifecycle.cleanup(), { code: "ENOTEMPTY" });
  assert.equal(await readFile(blocker, "utf8"), "block cleanup\n");
  await rm(blocker);
  await lifecycle.cleanup();
  await lifecycle.cleanup();
  await assertMissing(path.join(fixture.scratchRoot, "dynamics"));
});

test("64 simultaneous cleanup calls join one idempotent owned-path removal", async (t) => {
  const fixture = await createBuildLoadFixture(t);
  const lifecycle = await fixture.persist();
  const callerSentinel = path.join(fixture.scratchRoot, "caller-sentinel");
  await writeFile(callerSentinel, "outside lifecycle ownership\n");
  const cleanups = Array.from({ length: 64 }, () => lifecycle.cleanup());
  assert.equal(cleanups.every((cleanup) => cleanup === cleanups[0]), true);
  const settled = await Promise.allSettled(cleanups);
  assert.equal(settled.every((result) => result.status === "fulfilled"), true);
  await assertMissing(path.join(fixture.scratchRoot, "dynamics"));
  assert.equal(await readFile(callerSentinel, "utf8"), "outside lifecycle ownership\n");
  await lifecycle.cleanup();
});

test("symlink roots and pre-existing content-address symlinks are rejected without deletion", async (t) => {
  const fixture = await createBuildLoadFixture(t);
  const linkedRoot = path.join(fixture.scratchRoot, "root-link");
  await symlink(fixture.evidenceRoot, linkedRoot, "dir");
  await assert.rejects(
    () => fixture.persist({ scratchRoot: linkedRoot }),
    /must not contain symlinks/u
  );
  assert.equal((await lstat(linkedRoot)).isSymbolicLink(), true);

  const dynamics = path.join(fixture.scratchRoot, "dynamics");
  const artifactDirectory = path.join(
    dynamics,
    `sha256-${fixture.prepared.artifactSha256}`
  );
  const externalDirectory = path.join(fixture.evidenceRoot, "caller-directory");
  const sentinel = path.join(externalDirectory, "sentinel");
  await mkdir(dynamics);
  await mkdir(externalDirectory);
  await writeFile(sentinel, "caller-owned\n");
  await symlink(externalDirectory, artifactDirectory, "dir");
  await assert.rejects(() => fixture.persist(), { code: "EEXIST" });
  assert.equal((await lstat(artifactDirectory)).isSymbolicLink(), true);
  assert.equal(await readFile(sentinel, "utf8"), "caller-owned\n");
});

test("scratch conflict preserves caller receipt and never publishes a partial pair", async (t) => {
  const fixture = await createBuildLoadFixture(t);
  const dynamics = path.join(fixture.scratchRoot, "dynamics");
  const receipt = path.join(dynamics, "build-receipt.json");
  await mkdir(dynamics);
  await writeFile(receipt, "caller scratch sentinel\n");
  await assert.rejects(() => fixture.persist(), /target already exists/u);
  assert.equal(await readFile(receipt, "utf8"), "caller scratch sentinel\n");
  assert.deepEqual(await readdir(dynamics), ["build-receipt.json"]);
});

test("artifact/receipt identity cannot be mixed across prepared builds", async (t) => {
  const fixture = await createBuildLoadFixture(t);
  const otherPrepared = preparedWithBody(fixture.prepared, "export const other = true;\n");
  await assert.rejects(
    () => fixture.persist({ prepared: otherPrepared }),
    /receipt bytes mismatch/u
  );
  await assertMissing(path.join(fixture.scratchRoot, "dynamics"));
});
