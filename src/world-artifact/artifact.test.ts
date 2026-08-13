import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, lstat, mkdtemp, mkdir, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

import { createDynamicsBuildSourceSnapshot } from "../dynamics/buildSourceSnapshot.js";
import { assertWorldServiceArtifactManifest, createWorldServiceArtifact, createWorldServiceContract, parseWorldServiceArtifactManifest } from "./artifact.js";
import { assertWorldArtifactMetafileInputs, assertWorldArtifactRegularAncestors, readWorldArtifactLock, validateWorldArtifactPackage } from "./authority.js";

const contract = (): ReturnType<typeof createWorldServiceContract> => createWorldServiceContract({
  dynamics_provider: "d", world_surface: "s", capability_manifest: "c", world_act_request: "a", world_checkpoint: "k", world_runtime: "WorldRuntime", handler: "WorldRequestHandler", adapters: { json: "WorldJsonServer", mcp: "WorldMcpProtocolServer" }, operations: ["status"], spawnfile_receipts: ["receipt"], world_bindings: "bindings",
});
const dependencyRoot = process.cwd();
const fixture = async (): Promise<{ root: string; remove(): Promise<void> }> => {
  const root = await mkdtemp(path.join(process.cwd(), ".world-artifact-"));
  await mkdir(path.join(root, "src", "world-artifact"), { recursive: true });
  await mkdir(path.join(root, "node_modules"));
  await Promise.all(["package.json", "package-lock.json"].map(async (file) => writeFile(path.join(root, file), await readFile(path.join(process.cwd(), file)))));
  await Promise.all(["esbuild", "typescript"].map((name) => symlink(path.join(process.cwd(), "node_modules", name), path.join(root, "node_modules", name))));
  await writeFile(path.join(root, "src", "world-artifact", "entrypoint.ts"), 'export const marker = "WorldRuntime";\n');
  return { root, remove: () => rm(root, { recursive: true, force: true }) };
};
const nativePackage = (): string => {
  if (process.platform === "darwin") return `@esbuild/darwin-${process.arch}`;
  if (process.platform === "linux") return `@esbuild/linux-${process.arch}`;
  throw new Error(`test fixture lacks native package mapping for ${process.platform}/${process.arch}`);
};
const mutableFixture = async (): Promise<{ root: string; dependencyRoot: string; paths: Readonly<{ typescript: string; esbuild: string; native: string }>; remove(): Promise<void> }> => {
  const root = await mkdtemp(path.join(process.cwd(), ".world-artifact-mutable-")); const dependencyRoot = path.join(root, "dependency");
  await mkdir(path.join(root, "src", "world-artifact"), { recursive: true }); await mkdir(path.join(root, "node_modules")); await mkdir(path.join(dependencyRoot, "node_modules"), { recursive: true });
  await Promise.all([root, dependencyRoot].flatMap((target) => ["package.json", "package-lock.json"].map(async (file) => writeFile(path.join(target, file), await readFile(path.join(process.cwd(), file))))));
  const native = nativePackage();
  await Promise.all(["typescript", "esbuild", native].map(async (name) => {
    const source = path.join(process.cwd(), "node_modules", name); const target = path.join(dependencyRoot, "node_modules", name);
    await mkdir(path.dirname(target), { recursive: true }); await cp(source, target, { recursive: true });
  }));
  await Promise.all(["typescript", "esbuild"].map((name) => symlink(path.join(dependencyRoot, "node_modules", name), path.join(root, "node_modules", name))));
  await writeFile(path.join(root, "src", "world-artifact", "entrypoint.ts"), 'export const marker = "WorldRuntime";\n');
  return { root, dependencyRoot, paths: Object.freeze({ typescript: path.join(dependencyRoot, "node_modules", "typescript", "lib", "typescript.js"), esbuild: path.join(dependencyRoot, "node_modules", "esbuild", "lib", "main.js"), native: path.join(dependencyRoot, "node_modules", native, process.platform === "win32" ? "esbuild.exe" : "bin", "esbuild") }), remove: () => rm(root, { recursive: true, force: true }) };
};
const frozenGraph = (value: unknown): void => {
  if (!value || typeof value !== "object") return;
  assert.equal(Object.isFrozen(value), true);
  for (const child of Object.values(value as Record<string, unknown>)) frozenGraph(child);
};

test("captures deterministic immutable bytes and a strict B87-compatible manifest", async () => {
  const item = await fixture();
  try {
    const first = await createWorldServiceArtifact({ source_root: item.root, dependency_root: dependencyRoot, contract: contract() });
    const second = await createWorldServiceArtifact({ contract: contract(), source_root: item.root, dependency_root: dependencyRoot });
    assert.deepEqual(first.manifest, second.manifest);
    assert.deepEqual(first.artifact_bytes, second.artifact_bytes);
    assert.match(first.manifest.digest, /^sha256:[0-9a-f]{64}$/u);
    const parsed = parseWorldServiceArtifactManifest(JSON.parse(new TextDecoder().decode(Uint8Array.from(first.manifest_bytes))));
    assert.deepEqual(parsed, first.manifest); frozenGraph(parsed);
    assert.throws(() => assertWorldServiceArtifactManifest({ ...first.manifest, node: { ...first.manifest.node, arch: "forged" } }), /unsafe|manifest/u);
    assert.throws(() => createWorldServiceContract({ ...contract().contracts, extra: "forged" }), /unsafe/u);
  } finally { await item.remove(); }
});

test("loads the exact emitted MCP closure as ESM without starting a world", async () => {
  const artifact = await createWorldServiceArtifact({ source_root: process.cwd(), dependency_root: dependencyRoot, contract: contract() });
  const directory = await mkdtemp(path.join(os.tmpdir(), "world-artifact-load-")); const emitted = path.join(directory, "artifact.mjs");
  try {
    const bytes = Uint8Array.from(artifact.artifact_bytes); await writeFile(emitted, bytes);
    const loaded = await import(pathToFileURL(emitted).href);
    assert.equal(typeof loaded.createWorldServiceEntrypoint, "function");
    assert.match(new TextDecoder().decode(bytes), /createWorldRuntime/u);
    assert.doesNotMatch(new TextDecoder().decode(bytes), /(?:^|\n)\s*(?:import|export)\s+(?:[^"\n]*?\sfrom\s+)?["'](?!node:)/mu);
    assert.equal(artifact.manifest.node.builtins.every((item) => item.startsWith("node:")), true);
    assert.equal(artifact.manifest.source_files.some((file) => file.path.includes("/node_modules/")), true);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("binds parsing and digesting to one in-read lock generation, then rejects ancestor or external-link substitution", async () => {
  const item = await fixture(); const outside = await mkdtemp(path.join(os.tmpdir(), "world-artifact-fake-"));
  try {
    const lockPath = path.join(item.root, "package-lock.json"); const originalBytes = await readFile(lockPath); const replacement = new TextEncoder().encode(`${new TextDecoder().decode(originalBytes)}\n`);
    let mutated = false;
    const raced = await readWorldArtifactLock(item.root, {
      readBytes: async (fileName: string): Promise<Uint8Array> => {
        if (path.resolve(fileName) === lockPath) { await writeFile(lockPath, replacement); mutated = true; return replacement; }
        return readFile(fileName);
      }
    });
    assert.equal(mutated, true, "the valid lock replacement occurred inside the lock read");
    assert.equal(raced.lock.lockDigest, raced.lockDigest, "parsed lock authority and recorded digest use one returned generation");
    assert.equal(raced.lockDigest, createHash("sha256").update(replacement).digest("hex"));
    await writeFile(lockPath, originalBytes);
    const ancestor = path.join(outside, "ancestor"); await mkdir(path.join(ancestor, "child"), { recursive: true });
    const linked = path.join(outside, "linked"); await symlink(ancestor, linked); assert.equal((await lstat(linked)).isSymbolicLink(), true);
    await assert.rejects(assertWorldArtifactRegularAncestors(path.join(linked, "child")), /ancestor/u);
    await mkdir(path.join(outside, "node_modules", "esbuild"), { recursive: true });
    await Promise.all(["package.json", "package-lock.json"].map(async (file) => writeFile(path.join(outside, file), await readFile(path.join(item.root, file)))));
    await writeFile(path.join(outside, "node_modules", "esbuild", "package.json"), await readFile(path.join(dependencyRoot, "node_modules", "esbuild", "package.json")));
    const localEsbuild = path.join(item.root, "node_modules", "esbuild"); await unlink(localEsbuild); await symlink(path.join(outside, "node_modules", "esbuild"), localEsbuild);
    assert.equal((await lstat(localEsbuild)).isSymbolicLink(), true);
    await assert.rejects(createWorldServiceArtifact({ source_root: item.root, dependency_root: dependencyRoot, contract: contract() }), /authorized dependency installation/u);
  } finally { await item.remove(); await rm(outside, { recursive: true, force: true }); }
});

test("rejects exact metafile drift and every recorded tool provenance field", async () => {
  const expected = new Set([path.join(process.cwd(), "one.ts")]);
  assert.throws(() => assertWorldArtifactMetafileInputs(expected, ["two.ts"], process.cwd()), /metafile/u);
  assert.throws(() => assertWorldArtifactMetafileInputs(expected, ["one.ts", "two.ts"], process.cwd()), /metafile/u);
  const item = await fixture();
  try {
    const artifact = await createWorldServiceArtifact({ source_root: item.root, dependency_root: dependencyRoot, contract: contract() });
    for (const axis of ["version", "manifest_digest", "lock_path", "lock_digest"] as const) {
      const forged = structuredClone(artifact.manifest) as unknown as Record<string, unknown>;
      const tools = forged.build_tools as Record<string, Record<string, string>>;
      tools.esbuild[axis] = `${tools.esbuild[axis]}-forged`;
      assert.throws(() => parseWorldServiceArtifactManifest(forged), /digest|unsafe|manifest|invalid|path/u, axis);
    }
    const axes = [
      ["build_tools", "typescript", "entry", "path"], ["build_tools", "typescript", "entry", "bytes"], ["build_tools", "typescript", "entry", "digest"],
      ["build_tools", "esbuild", "entry", "path"], ["build_tools", "esbuild", "entry", "bytes"], ["build_tools", "esbuild", "entry", "digest"],
      ["execution_provenance", "typescript", "files", 0, "path"], ["execution_provenance", "typescript", "files", 0, "bytes"], ["execution_provenance", "typescript", "files", 0, "digest"], ["execution_provenance", "typescript", "digest"], ["execution_provenance", "esbuild", "files", 0, "path"], ["execution_provenance", "esbuild", "files", 0, "bytes"], ["execution_provenance", "esbuild", "files", 0, "digest"], ["execution_provenance", "esbuild", "files", 1, "path"], ["execution_provenance", "esbuild", "files", 1, "bytes"], ["execution_provenance", "esbuild", "files", 1, "digest"], ["execution_provenance", "esbuild", "digest"],
    ] as const;
    for (const axis of axes) {
      const forged = structuredClone(artifact.manifest) as unknown as Record<string, unknown>; let target: unknown = forged;
      for (const key of axis.slice(0, -1)) target = (target as Record<string, unknown>)[key];
      const leaf = axis[axis.length - 1] as string; (target as Record<string, unknown>)[leaf] = typeof (target as Record<string, unknown>)[leaf] === "number" ? 1 : "sha256:0000000000000000000000000000000000000000000000000000000000000000";
      assert.throws(() => parseWorldServiceArtifactManifest(forged), /digest|unsafe|manifest|invalid|path/u, axis.join("."));
    }
    for (const malformed of [
      ((value: Record<string, unknown>) => { delete ((value.execution_provenance as Record<string, Record<string, unknown>>).esbuild as Record<string, unknown>).digest; }),
      ((value: Record<string, unknown>) => { ((value.execution_provenance as Record<string, Record<string, unknown>>).esbuild as Record<string, unknown>).extra = "forged"; }),
      ((value: Record<string, unknown>) => { ((value.execution_provenance as Record<string, Record<string, unknown>>).esbuild.files as unknown[]).push({ path: "node_modules/esbuild/bin/esbuild", bytes: 1, digest: "sha256:0000000000000000000000000000000000000000000000000000000000000000" }); }),
    ]) { const forged = structuredClone(artifact.manifest) as unknown as Record<string, unknown>; malformed(forged); assert.throws(() => parseWorldServiceArtifactManifest(forged), /unsafe|manifest|invalid/u); }
  } finally { await item.remove(); }
});

test("records or rejects unchanged-metadata mutations of every executed tool authority", async () => {
  for (const axis of ["typescript", "esbuild", "native"] as const) {
    const baseline = await mutableFixture(); const mutated = await mutableFixture();
    try {
      const before = await createWorldServiceArtifact({ source_root: baseline.root, dependency_root: baseline.dependencyRoot, contract: contract() }); const target = mutated.paths[axis];
      const packageBefore = await readFile(path.join(mutated.dependencyRoot, "package.json")); const lockBefore = await readFile(path.join(mutated.dependencyRoot, "package-lock.json")); const original = await readFile(target);
      await writeFile(target, Buffer.concat([original, Buffer.from(axis === "native" ? "\nworld-artifact-native-mutation\n" : `\n/* world-artifact-${axis}-mutation */\n`)]));
      assert.notDeepEqual(await readFile(target), original, `${axis} mutation changed the selected execution file`);
      assert.deepEqual(await readFile(path.join(mutated.dependencyRoot, "package.json")), packageBefore, `${axis} package metadata stayed unchanged`);
      assert.deepEqual(await readFile(path.join(mutated.dependencyRoot, "package-lock.json")), lockBefore, `${axis} lock bytes stayed unchanged`);
      let after: Awaited<ReturnType<typeof createWorldServiceArtifact>> | undefined;
      try { after = await createWorldServiceArtifact({ source_root: mutated.root, dependency_root: mutated.dependencyRoot, contract: contract() }); } catch (error) { assert.equal(error instanceof Error, true, `${axis} altered tool fails closed when it cannot execute`); }
      if (after) {
        assert.notEqual(after.manifest.digest, before.manifest.digest, `${axis} mutation changes manifest provenance`);
        const beforeClosure = axis === "typescript" ? before.manifest.execution_provenance.typescript : before.manifest.execution_provenance.esbuild;
        const afterClosure = axis === "typescript" ? after.manifest.execution_provenance.typescript : after.manifest.execution_provenance.esbuild;
        assert.notEqual(afterClosure.digest, beforeClosure.digest, `${axis} mutation changes exact execution closure provenance`);
      }
    } finally { await baseline.remove(); await mutated.remove(); }
  }
});

test("rejects a same-root TypeScript entry mutation instead of executing its cached implementation", async () => {
  const item = await mutableFixture();
  try {
    await createWorldServiceArtifact({ source_root: item.root, dependency_root: item.dependencyRoot, contract: contract() });
    const packageBefore = await readFile(path.join(item.dependencyRoot, "package.json")); const lockBefore = await readFile(path.join(item.dependencyRoot, "package-lock.json")); const original = await readFile(item.paths.typescript);
    const originalText = new TextDecoder().decode(original); const mutatedText = originalText.replace('var version = "5.9.3";', 'var version = "world-artifact-stale-cache-regression";');
    assert.notEqual(mutatedText, originalText, "TypeScript version implementation changed"); await writeFile(item.paths.typescript, mutatedText);
    assert.deepEqual(await readFile(path.join(item.dependencyRoot, "package.json")), packageBefore, "package metadata stayed unchanged");
    assert.deepEqual(await readFile(path.join(item.dependencyRoot, "package-lock.json")), lockBefore, "lock bytes stayed unchanged");
    await assert.rejects(createWorldServiceArtifact({ source_root: item.root, dependency_root: item.dependencyRoot, contract: contract() }), /typescript tool version is invalid/u);
  } finally { await item.remove(); }
});

test("rejects esbuild environment binary substitution before tool resolution", async () => {
  const item = await fixture(); const prior = process.env.ESBUILD_BINARY_PATH;
  try {
    process.env.ESBUILD_BINARY_PATH = path.join(item.root, "unproven-esbuild");
    await assert.rejects(createWorldServiceArtifact({ source_root: item.root, dependency_root: dependencyRoot, contract: contract() }), /environment binary substitution/u);
  } finally { if (prior === undefined) delete process.env.ESBUILD_BINARY_PATH; else process.env.ESBUILD_BINARY_PATH = prior; await item.remove(); }
});

test("rejects repeated package paths that alias one locked dependency", async () => {
  const item = await fixture();
  try {
    const repeated = path.join(item.root, "node_modules", "esbuild", "node_modules", "typescript");
    await unlink(path.join(item.root, "node_modules", "esbuild")); await mkdir(path.dirname(repeated), { recursive: true });
    await symlink(path.join(dependencyRoot, "node_modules", "typescript"), repeated); assert.equal((await lstat(repeated)).isSymbolicLink(), true);
    const snapshot = createDynamicsBuildSourceSnapshot(); const lock = await readWorldArtifactLock(item.root, snapshot);
    await assert.rejects(validateWorldArtifactPackage(item.root, dependencyRoot, path.join(repeated, "package.json"), lock.lock, lock.lockDigest, snapshot), /duplicate portable path/u);
  } finally { await item.remove(); }
});

test("rejects hostile graph values before authority is produced", () => {
  const alias: Record<string, unknown> = {}; const cyclic: Record<string, unknown> = { alias, other: alias }; cyclic.self = cyclic;
  for (const value of [new Proxy({}, {}), { get version(): string { throw new Error("read"); } }, cyclic, { version: Symbol("x") }]) {
    assert.throws(() => parseWorldServiceArtifactManifest(value), /unsafe|manifest/u);
  }
  const sparse: unknown[] = []; sparse[1] = "x";
  assert.throws(() => createWorldServiceContract({ ...contract().contracts, operations: sparse }), /unsafe/u);
});
