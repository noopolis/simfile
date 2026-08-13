import { lstat, readFile } from "node:fs/promises";
import path from "node:path";

import { sha256 } from "./buildIdentity.js";
import { DYNAMICS_BUILD_PREPARATION_POLICY } from "./buildInput.js";

export interface PackageIdentity {
  readonly directory: string;
  readonly manifestSha256: string;
  readonly name: string;
  readonly version: string;
}

const packagePolicy = DYNAMICS_BUILD_PREPARATION_POLICY.package;
const packageName = new RegExp(packagePolicy.namePattern, "u");
const packageVersion = new RegExp(packagePolicy.versionPattern, "u");
const packageManifest = packagePolicy.manifestFileName;
const nodeModulesDirectory = packagePolicy.nodeModulesDirectory;
const scopePrefix = packagePolicy.scopePrefix;
const declarationExtensions = DYNAMICS_BUILD_PREPARATION_POLICY.source.declarationExtensions;

interface OwnedPackageSource {
  readonly fileName: string;
  readonly identity?: PackageIdentity;
}
type PackageByteReader = (fileName: string) => Promise<Uint8Array>;

export const isContained = (root: string, candidate: string): boolean => {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
};

/** Maps DefinitelyTyped package ownership back to the runtime package it describes. */
export const runtimePackageNameForTypes = (name: string): string => {
  if (!name.startsWith("@types/")) return name;
  const encoded = name.slice("@types/".length);
  const scoped = encoded.indexOf("__");
  return scoped < 0
    ? encoded
    : `@${encoded.slice(0, scoped)}/${encoded.slice(scoped + 2)}`;
};

export const declarationBackedRuntimeRoots = (
  runtimeInputs: readonly string[],
  sources: ReadonlyMap<string, OwnedPackageSource>,
  typeSources: readonly OwnedPackageSource[],
  explicitProjectRoots: readonly string[] = []
): ReadonlySet<string> => {
  const declaredPackages = new Set(typeSources
    .filter((source) =>
      declarationExtensions.some((extension) => source.fileName.endsWith(extension))
      && source.identity)
    .map((source) => runtimePackageNameForTypes((source.identity as PackageIdentity).name)));
  const packageBacked = runtimeInputs.filter((fileName) => {
    const identity = sources.get(fileName)?.identity;
    return identity !== undefined && declaredPackages.has(identity.name);
  });
  const declaredProjectRoots = new Set(explicitProjectRoots.map((fileName) => path.resolve(fileName)));
  return new Set([...packageBacked, ...runtimeInputs.filter((fileName) => declaredProjectRoots.has(path.resolve(fileName)))]);
};

const manifestAt = async (
  directory: string,
  required: boolean,
  expectedName?: string,
  readBytes: PackageByteReader = readFile
): Promise<PackageIdentity | undefined> => {
  const manifestPath = path.join(directory, packageManifest);
  try {
    const stat = await lstat(manifestPath);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`package manifest must be a regular file: ${manifestPath}`);
    const bytes = await readBytes(manifestPath);
    const manifest: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (!manifest || Array.isArray(manifest) || typeof manifest !== "object") throw new Error(`package manifest must be a JSON object: ${manifestPath}`);
    const { name, version } = manifest as { name?: unknown; version?: unknown };
    if (typeof name !== "string" || !packageName.test(name) || typeof version !== "string" || !packageVersion.test(version)) {
      throw new Error(`package manifest has an invalid package identity: ${manifestPath}`);
    }
    if (expectedName && name !== expectedName) throw new Error(`package manifest name does not own its node_modules path: ${manifestPath}`);
    return { directory, manifestSha256: sha256(bytes), name, version };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" && !required) return undefined;
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`package manifest is required: ${manifestPath}`);
    if (error instanceof SyntaxError) throw new Error(`package manifest is not valid JSON: ${manifestPath}`);
    throw error;
  }
};

const nodeModulesRootFor = (fileName: string): string | undefined => {
  for (let directory = path.dirname(fileName);;) {
    if (path.basename(directory) === nodeModulesDirectory) return directory;
    const parent = path.dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
};

const ownerFor = (fileName: string, root: string): Readonly<{ directory: string; name: string }> => {
  const [first, second] = path.relative(root, fileName).split(path.sep);
  if (!first || first === ".." || (first.startsWith(scopePrefix) && !second)) {
    throw new Error(`reachable code has no owning package below ${root}: ${fileName}`);
  }
  return first.startsWith(scopePrefix)
    ? { directory: path.join(root, first, second), name: `${first}/${second}` }
    : { directory: path.join(root, first), name: first };
};

/** Finds the nearest node_modules owner and rejects every invalid boundary. */
export const nodeModulesPackageFor = async (
  fileName: string,
  readBytes: PackageByteReader = readFile
): Promise<PackageIdentity | undefined> => {
  const root = nodeModulesRootFor(fileName);
  if (!root) return undefined;
  const owner = ownerFor(fileName, root);
  return manifestAt(owner.directory, true, owner.name, readBytes);
};

/** Finds the nearest enclosing regular package for external sources. */
export const enclosingPackageFor = async (
  fileName: string,
  readBytes: PackageByteReader = readFile
): Promise<PackageIdentity | undefined> => {
  for (let directory = path.dirname(fileName);;) {
    const identity = await manifestAt(directory, false, undefined, readBytes);
    if (identity) return identity;
    const parent = path.dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
};
