import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import ts from "typescript";

import { createStaticCompilerReadGuard } from "./buildStaticCompilerHostPolicy.js";

interface CompilerHostTestPaths {
  known: string;
  entry: string;
  alias: string;
  replacement: string;
  defaultRoot: string;
  manifest: string;
  outsideManifest: string;
  recorded: string;
  unrecorded: string;
  source: string;
  present: string;
  absent: string;
  directory: string;
  symlinked: string;
  late: string;
  lateIndex: string;
  packageJson: string;
}

const compilerOptions: ts.CompilerOptions = {
  module: ts.ModuleKind.NodeNext,
  moduleResolution: ts.ModuleResolutionKind.NodeNext,
  noLib: true,
  target: ts.ScriptTarget.ES2022
};

const withCompilerRoots = async <T>(run: (root: string, outside: string) => Promise<T>): Promise<T> => {
  const root = await mkdtemp(path.join(os.tmpdir(), "simfile-compiler-"));
  const outside = await mkdtemp(path.join(os.tmpdir(), "simfile-compiler-outside-"));
  try {
    return await run(root, outside);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
};

const createTrackedCompilerDelegate = (overrides: { fileExists?: (fileName: string) => boolean; readFile?: (fileName: string) => string; } = {}): {
  counts: { fileExists: number; readFile: number };
  delegate: ts.ModuleResolutionHost;
} => {
  const counts = { fileExists: 0, readFile: 0 };
  return {
    counts,
    delegate: {
      fileExists: (fileName) => { counts.fileExists += 1; return overrides.fileExists?.(fileName) ?? true; },
      readFile: (fileName) => {
        counts.readFile += 1;
        if (overrides.readFile) return overrides.readFile(fileName);
        try {
          return readFileSync(fileName, "utf8");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
          throw error;
        }
      }
    }
  };
};

const setupCompilerHostFixture = async (root: string, outside: string): Promise<CompilerHostTestPaths> => {
  const rootDirectory = path.join(root, "node_modules", "@types");
  const paths: CompilerHostTestPaths = {
    known: path.join(root, "known.d.ts"),
    entry: path.join(root, "entry.ts"),
    alias: path.join(root, "alias"),
    replacement: path.join(root, "replacement.d.ts"),
    defaultRoot: path.join(root, "default-root"),
    manifest: path.join(root, "node_modules", "safe", "package.json"),
    outsideManifest: path.join(outside, "package.json"),
    recorded: path.join(root, "recorded.d.ts"),
    unrecorded: path.join(root, "unrecorded.d.ts"),
    source: path.join(root, "source.d.ts"),
    present: path.join(root, "default-root", "present.d.ts"),
    absent: path.join(root, "default-root", "absent.d.ts"),
    directory: path.join(root, "default-root", "directory"),
    symlinked: path.join(root, "default-root", "symlinked.d.ts"),
    late: path.join(root, "late.d.ts"),
    lateIndex: path.join(rootDirectory, "late", "index.d.ts"),
    packageJson: path.join(rootDirectory, "package.json")
  };

  await mkdir(paths.defaultRoot, { recursive: true });
  await Promise.all([
    mkdir(paths.directory),
    mkdir(path.dirname(paths.lateIndex), { recursive: true }),
    mkdir(path.dirname(paths.manifest), { recursive: true })
  ]);

  await Promise.all([
    writeFile(paths.known, "export type Known = number;\n"),
    writeFile(paths.entry, "export type Entry = 1;\n"),
    writeFile(paths.late, "export type Late = number;\n"),
    writeFile(paths.source, "export type Value = number;\n"),
    writeFile(paths.present, "export type Present = number;\n"),
    writeFile(paths.recorded, "export type Recorded = number;\n"),
    writeFile(paths.unrecorded, "export type Unrecorded = number;\n"),
    writeFile(paths.replacement, "export type Replacement = number;\n"),
    writeFile(paths.outsideManifest, "{}", "utf8"),
    writeFile(paths.lateIndex, "export type Late = 1;\n"),
    writeFile(paths.packageJson, "{}", "utf8")
  ]);
  await symlink(paths.outsideManifest, paths.manifest);
  await symlink(root, paths.alias);
  await symlink(paths.replacement, paths.symlinked);
  return paths;
};

describe("static compiler host read guard policy", () => {
  it("rejects preflight read of a symlinked package manifest before delegate read", async () => {
    await withCompilerRoots(async (root, outside) => {
      const paths = await setupCompilerHostFixture(root, outside);
      const delegate = createTrackedCompilerDelegate();
      const guard = createStaticCompilerReadGuard([root], outside, delegate.delegate);

      assert.throws(() => guard.preflightResolutionHost.readFile?.(paths.manifest), /symlink/i);
      assert.throws(() => guard.preflightResolutionHost.readFile?.(path.join(root, "alias", "source.d.ts")), /symlink/i);
      assert.deepEqual(delegate.counts, { fileExists: 0, readFile: 0 });
    });
  });

  it("hides out-of-authority resolution candidates without reading them", async () => {
    await withCompilerRoots(async (root, outside) => {
      const paths = await setupCompilerHostFixture(root, outside);
      const delegate = createTrackedCompilerDelegate();
      const guard = createStaticCompilerReadGuard([root], paths.defaultRoot, delegate.delegate);

      assert.equal(guard.preflightResolutionHost.fileExists?.(paths.outsideManifest), false);
      assert.throws(
        () => guard.preflightResolutionHost.readFile?.(paths.outsideManifest),
        /outside approved lexical roots/u
      );
      assert.deepEqual(delegate.counts, { fileExists: 0, readFile: 0 });
    });
  });

  it("validates the most specific approved anchor and rejects a symlinked approved anchor", async () => {
    await withCompilerRoots(async (root, outside) => {
      const paths = await setupCompilerHostFixture(root, outside);
      const nestedAnchor = path.join(root, "specific-anchor");
      const nestedFile = path.join(nestedAnchor, "specific.d.ts");

      await mkdir(nestedAnchor);
      await writeFile(nestedFile, "export type Specific = number;\n");

      const nestedDelegate = createTrackedCompilerDelegate();
      const nestedGuard = createStaticCompilerReadGuard([root, nestedAnchor], outside, nestedDelegate.delegate);
      assert.doesNotThrow(() => nestedGuard.assertPreflightRead(nestedFile));
      assert.deepEqual(nestedDelegate.counts, { fileExists: 0, readFile: 0 });

      const symlinkedAnchor = path.join(root, "nested-anchor-link");
      await symlink(nestedAnchor, symlinkedAnchor);

      const symlinkedDelegate = createTrackedCompilerDelegate();
      const symlinkedGuard = createStaticCompilerReadGuard([symlinkedAnchor], outside, symlinkedDelegate.delegate);
      assert.throws(() => symlinkedGuard.assertPreflightRead(path.join(symlinkedAnchor, "specific.d.ts")), /approved anchor is not a regular nonsymlink directory|symlink/i);
      assert.deepEqual(symlinkedDelegate.counts, { fileExists: 0, readFile: 0 });
    });
  });

  it("freezes preflight evidence once and returns the same immutable snapshot", async () => {
    await withCompilerRoots(async (root, outside) => {
      const paths = await setupCompilerHostFixture(root, outside);
      const delegate = createTrackedCompilerDelegate();
      const guard = createStaticCompilerReadGuard([root], outside, delegate.delegate);

      guard.assertPreflightRead(paths.recorded);
      const first = guard.freezePreflight();
      const second = guard.freezePreflight();
      assert.equal(first, second);
      assert.deepEqual(first, [paths.recorded]);
    });
  });

  it("allows a recorded file through checked read delegates after freeze", async () => {
    await withCompilerRoots(async (root, outside) => {
      const paths = await setupCompilerHostFixture(root, outside);
      const delegate = createTrackedCompilerDelegate();
      const guard = createStaticCompilerReadGuard([root], outside, delegate.delegate);

      guard.assertPreflightRead(paths.known);
      assert.deepEqual(guard.freezePreflight(), [paths.known]);
      assert.equal(guard.checkedResolutionHost.fileExists?.(paths.known), true);
      assert.equal(guard.checkedResolutionHost.readFile?.(paths.known), "export type Known = number;\n");
      assert.deepEqual(delegate.counts, { fileExists: 1, readFile: 1 });
    });
  });

  it("never reads unknown existing or absent non-default candidates through checked delegates", async () => {
    await withCompilerRoots(async (root, outside) => {
      const paths = await setupCompilerHostFixture(root, outside);
      const delegate = createTrackedCompilerDelegate();
      const guard = createStaticCompilerReadGuard([root], outside, delegate.delegate);

      guard.assertPreflightRead(paths.recorded);
      guard.freezePreflight();
      assert.equal(guard.checkedResolutionHost.fileExists?.(paths.unrecorded), false);
      assert.equal(guard.checkedResolutionHost.fileExists?.(path.join(root, "absent.d.ts")), false);
      assert.throws(() => guard.checkedResolutionHost.readFile?.(paths.unrecorded), /immutable preflight evidence/u);
      assert.equal(delegate.counts.fileExists, 0);
      assert.equal(delegate.counts.readFile, 0);
      assert.deepEqual(guard.frozenPreflightPaths(), [paths.recorded]);
    });
  });

  it("prevents alternative module and type-reference resolution from delegating or expanding frozen evidence", async () => {
    await withCompilerRoots(async (root, outside) => {
      const paths = await setupCompilerHostFixture(root, outside);
      const rootDirectory = path.dirname(paths.packageJson);
      const delegate = createTrackedCompilerDelegate();
      const guard = createStaticCompilerReadGuard([root], outside, delegate.delegate);
      const frozenBefore = guard.frozenPreflightPaths();

      guard.assertPreflightRead(paths.entry);
      const frozenEvidence = guard.freezePreflight();
      assert.equal(ts.resolveModuleName(
        "./missing",
        paths.known,
        compilerOptions,
        guard.checkedResolutionHost
      ).resolvedModule, undefined);
      assert.equal(ts.resolveTypeReferenceDirective(
        "late",
        paths.known,
        { ...compilerOptions, typeRoots: [rootDirectory] },
        guard.checkedResolutionHost
      ).resolvedTypeReferenceDirective, undefined);
      assert.deepEqual(delegate.counts, { fileExists: 0, readFile: 0 });
      assert.equal(frozenBefore, undefined);
      assert.deepEqual(guard.frozenPreflightPaths(), frozenEvidence);
    });
  });

  it("blocks checked getSourceFile for an unrecorded root source", async () => {
    await withCompilerRoots(async (root, outside) => {
      const paths = await setupCompilerHostFixture(root, outside);
      const delegate = createTrackedCompilerDelegate();
      const guard = createStaticCompilerReadGuard([root], outside, delegate.delegate);

      guard.assertPreflightRead(paths.recorded);
      guard.freezePreflight();
      const baseHost = ts.createCompilerHost(compilerOptions, true);
      const baseGetSourceFile = baseHost.getSourceFile!.bind(baseHost);
      const guardedHost = {
        ...baseHost,
        ...guard.checkedResolutionHost,
        getSourceFile: (fileName, languageVersion, onError, shouldCreateNewSourceFile) => {
          guard.assertCheckedRead(fileName);
          return baseGetSourceFile(fileName, languageVersion, onError, shouldCreateNewSourceFile);
        }
      } as ts.CompilerHost;

      assert.throws(() => ts.createProgram([paths.late], compilerOptions, guardedHost), /immutable preflight evidence|symlink/);
      assert.deepEqual(delegate.counts, { fileExists: 0, readFile: 0 });
      assert.deepEqual(guard.frozenPreflightPaths(), [paths.recorded]);
    });
  });

  it("rejects preflight writes after freeze", async () => {
    await withCompilerRoots(async (root, outside) => {
      const paths = await setupCompilerHostFixture(root, outside);
      const delegate = createTrackedCompilerDelegate();
      const guard = createStaticCompilerReadGuard([root], outside, delegate.delegate);

      guard.assertPreflightRead(paths.recorded);
      guard.freezePreflight();
      assert.throws(() => guard.assertPreflightRead(paths.late), /frozen/u);
    });
  });

  it("rejects checked reads when a recorded file has been converted to a symlink", async () => {
    await withCompilerRoots(async (root, outside) => {
      const paths = await setupCompilerHostFixture(root, outside);
      const delegate = createTrackedCompilerDelegate();
      const guard = createStaticCompilerReadGuard([root], outside, delegate.delegate);

      guard.assertPreflightRead(paths.recorded);
      guard.freezePreflight();
      await writeFile(paths.replacement, "export type Recorded = string;\n");
      await unlink(paths.recorded);
      await symlink(paths.replacement, paths.recorded);
      assert.throws(() => guard.checkedResolutionHost.readFile?.(paths.recorded), /symlink/u);
      assert.deepEqual(delegate.counts, { fileExists: 0, readFile: 0 });
    });
  });

  it("lets checked delegates read only regular default-root paths", async () => {
    await withCompilerRoots(async (root, outside) => {
      const paths = await setupCompilerHostFixture(root, outside);
      const delegate = createTrackedCompilerDelegate();
      const guard = createStaticCompilerReadGuard([root], paths.defaultRoot, delegate.delegate);

      for (const candidate of [paths.absent, paths.directory, paths.symlinked, paths.present]) {
        const before = delegate.counts.fileExists;
        assert.equal(guard.checkedResolutionHost.fileExists?.(candidate), candidate === paths.present);
        assert.equal(delegate.counts.fileExists, before + (candidate === paths.present ? 1 : 0));
      }
      assert.equal(guard.checkedResolutionHost.readFile?.(paths.present), "export type Present = number;\n");
      assert.equal(delegate.counts.readFile, 1);
    });
  });
});
