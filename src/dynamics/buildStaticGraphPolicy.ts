import { compareUtf16 } from "./buildIdentity.js";
import { sha256, type DynamicsBuildInputDescriptor } from "./buildIdentity.js";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { staticSourceSpecifiers, type StaticSourceSpecifier } from "./buildStaticResolverPolicy.js";
import { DYNAMICS_STATIC_CLOSURE_POLICY } from "./buildStaticPolicy.js";
import type { PackageIdentity } from "./buildPackagePolicy.js";

type InputMode = "runtime" | "type-only";
type StaticByteReader = (fileName: string) => Promise<Uint8Array>;
export interface StaticDescriptorSource extends StaticRuntimeGraphSource {
  readonly boundary: string;
  readonly identity?: PackageIdentity;
  readonly kind: "package" | "project";
}

const portable = (value: string): string => value.split(path.sep).join("/");

export const descriptorForStaticSource = async (
  source: StaticDescriptorSource,
  modes: ReadonlySet<InputMode>,
  projectRoot: string,
  readBytes: StaticByteReader = readFile
): Promise<DynamicsBuildInputDescriptor> => {
  if (source.kind === "project") return { kind: "project", modes: [...modes].sort(compareUtf16), path: `./${portable(path.relative(projectRoot, source.fileName))}`, sha256: sha256(await readBytes(source.fileName)) };
  if (!source.identity) throw new Error(`runtime source has no package identity: ${source.fileName}`);
  return { kind: "package", manifest_sha256: source.identity.manifestSha256, modes: [...modes].sort(compareUtf16), package_name: source.identity.name, package_path: `./${portable(path.relative(source.identity.directory, source.fileName))}`, package_version: source.identity.version, sha256: sha256(await readBytes(source.fileName)) };
};

export const staticTypeSurfaceDescriptor = async (files: readonly string[], root: string, identity: PackageIdentity, readBytes: StaticByteReader = readFile): Promise<DynamicsBuildInputDescriptor> => ({
  files: await Promise.all([...files].sort(compareUtf16).map(async (fileName) => ({ path: `./${portable(path.relative(root, fileName))}`, sha256: sha256(await readBytes(fileName)) }))),
  kind: "type-only", manifest_sha256: identity.manifestSha256, package_name: "simfile", package_version: identity.version, surface: "dynamics"
});

export const sortStaticInputs = (inputs: readonly DynamicsBuildInputDescriptor[]): DynamicsBuildInputDescriptor[] =>
  [...inputs].sort((left, right) => compareUtf16(JSON.stringify(left), JSON.stringify(right)));

export interface StaticRuntimeGraphSource {
  readonly fileName: string;
}

/** Builds immutable runtime-only reachability before esbuild observes files. */
export const preflightStaticRuntimeGraph = async <T extends StaticRuntimeGraphSource>(
  entries: readonly T[],
  allSources: ReadonlyMap<string, T>,
  read: (fileName: string) => Promise<string>,
  resolve: (specifier: StaticSourceSpecifier, importer: T) => Promise<string | undefined>
): Promise<ReadonlySet<string>> => {
  const runtime = new Set<string>();
  const queued = [...entries];
  for (let index = 0; index < queued.length; index += 1) {
    const source = queued[index] as T;
    if (runtime.has(source.fileName)) continue;
    runtime.add(source.fileName);
    for (const specifier of staticSourceSpecifiers(source.fileName, await read(source.fileName), DYNAMICS_STATIC_CLOSURE_POLICY)) {
      if (specifier.mode === "type-only") continue;
      const fileName = await resolve(specifier, source);
      if (fileName === undefined) continue;
      const target = allSources.get(fileName);
      if (!target) throw new Error(`runtime graph target was not independently preflighted: ${specifier.specifier}`);
      queued.push(target);
    }
  }
  return runtime;
};

export const assertExactRuntimeInputs = (expected: ReadonlySet<string>, actual: readonly string[]): void => {
  const observed = new Set(actual);
  const missing = [...expected].filter((fileName) => !observed.has(fileName)).sort(compareUtf16);
  const extra = [...observed].filter((fileName) => !expected.has(fileName)).sort(compareUtf16);
  if (missing.length || extra.length) {
    throw new Error(`runtime preflight evidence does not exactly match esbuild metafile inputs; missing: ${missing.join(", ") || "none"}; extra: ${extra.join(", ") || "none"}`);
  }
};
