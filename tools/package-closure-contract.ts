import { lstat, readFile } from "node:fs/promises";
import path from "node:path";

const STELE = "@noopolis/stele";
export const STELE_VERSION = "0.0.2";

type JsonObject = Record<string, unknown>;

export interface PackFileEntry {
  path: string;
}

export interface SinglePackManifest {
  bundled?: readonly string[];
  entryCount: number;
  filename: string;
  files: readonly PackFileEntry[];
  id: string;
  integrity: string;
  shasum: string;
}

export interface PackageManifest {
  bin?: JsonObject;
  bundleDependencies?: unknown;
  bundledDependencies?: unknown;
  dependencies?: JsonObject;
  name?: unknown;
  version?: unknown;
}

export const fail = (message: string): never => { throw new Error(message); };

const isObject = (value: unknown): value is JsonObject =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const objectAt = (value: unknown, key: string): JsonObject | undefined =>
  isObject(value) && isObject(value[key]) ? value[key] : undefined;

const dependenciesOf = (manifest: unknown): JsonObject =>
  isObject(manifest) && isObject(manifest.dependencies) ? manifest.dependencies : {};

export const readJson = async (filePath: string): Promise<unknown> =>
  JSON.parse(await readFile(filePath, "utf8"));

export const parseSinglePack = (stdout: string): SinglePackManifest => {
  let parsed: unknown;
  for (let index = stdout.lastIndexOf("["); index >= 0;
    index = stdout.lastIndexOf("[", index - 1)) {
    try {
      const candidate: unknown = JSON.parse(stdout.slice(index));
      if (Array.isArray(candidate)) { parsed = candidate; break; }
    } catch {
      // Lifecycle scripts may write before npm's final JSON array.
    }
  }
  if (!Array.isArray(parsed) || parsed.length !== 1) {
    return fail("npm pack must report exactly one tarball");
  }
  const packEntries = parsed;
  const [result] = packEntries;
  if (!isObject(result) || typeof result.filename !== "string"
    || !Array.isArray(result.files) || typeof result.integrity !== "string"
    || typeof result.shasum !== "string") {
    return fail("npm pack returned an invalid manifest");
  }
  const files: PackFileEntry[] = [];
  for (const entry of result.files) {
    if (!isObject(entry) || typeof entry.path !== "string") {
      return fail("npm pack returned an invalid file entry");
    }
    files.push({ path: entry.path });
  }
  const bundled = Array.isArray(result.bundled)
    && result.bundled.every((entry: unknown) => typeof entry === "string")
    ? result.bundled : undefined;
  return {
    bundled,
    entryCount: typeof result.entryCount === "number" ? result.entryCount : files.length,
    filename: result.filename,
    files,
    id: typeof result.id === "string" ? result.id : result.filename,
    integrity: result.integrity,
    shasum: result.shasum,
  };
};

export const assertRegistrySource = async (
  packageRoot: string,
  manifest: unknown,
  lock: unknown
): Promise<string> => {
  const dependencies = dependenciesOf(manifest);
  if (dependencies[STELE] !== STELE_VERSION) {
    fail(`${STELE} must use the published ${STELE_VERSION} release coordinate`);
  }
  if (isObject(manifest)
    && (manifest.bundledDependencies !== undefined || manifest.bundleDependencies !== undefined)) {
    fail("published registry dependencies must not be bundled");
  }
  for (const [name, coordinate] of Object.entries(dependencies)) {
    if (typeof coordinate !== "string" || /^(?:file|link|workspace):/u.test(coordinate)) {
      fail(`runtime dependency ${name} is not a registry coordinate`);
    }
  }
  const packages = objectAt(lock, "packages") ?? {};
  for (const [location, entry] of Object.entries(packages)) {
    if (location === "") continue;
    if (!isObject(entry)) continue;
    if (entry.link === true
      || (typeof entry.resolved === "string" && /^(?:file|link):/u.test(entry.resolved))) {
      fail(`package lock contains a checkout-relative dependency at ${location}`);
    }
  }
  const locked = objectAt(packages, `node_modules/${STELE}`);
  const expected = `https://registry.npmjs.org/@noopolis/stele/-/stele-${STELE_VERSION}.tgz`;
  if (locked === undefined || locked.version !== STELE_VERSION || locked.resolved !== expected) {
    return fail(`${STELE} lock entry must resolve to the exact npm registry tarball`);
  }
  const lockedEntry = locked;
  if (typeof lockedEntry.integrity !== "string" || !lockedEntry.integrity.startsWith("sha512-")) {
    fail(`${STELE} registry lock is missing sha512 integrity`);
  }
  const installed = path.join(packageRoot, "node_modules", STELE);
  if ((await lstat(installed)).isSymbolicLink()) {
    fail(`${STELE} must be physically installed; source-checkout links are rejected`);
  }
  const installedManifest = await readJson(path.join(installed, "package.json"));
  if (!isObject(installedManifest) || installedManifest.version !== STELE_VERSION) {
    fail(`${STELE} installed version drifted`);
  }
  return expected;
};

export const assertPackedManifest = (manifest: unknown): PackageManifest => {
  if (!isObject(manifest)) return fail("packed manifest is invalid");
  const manifestObject = manifest;
  const dependencies = dependenciesOf(manifestObject);
  if (manifestObject.version !== "0.0.3") fail("packed Simfile version drifted");
  if (dependencies[STELE] !== STELE_VERSION) fail(`packed ${STELE} coordinate drifted`);
  if (manifestObject.bundledDependencies !== undefined || manifestObject.bundleDependencies !== undefined) {
    fail("packed manifest unexpectedly bundles registry dependencies");
  }
  for (const [name, coordinate] of Object.entries(dependencies)) {
    if (typeof coordinate === "string" && /^(?:file|link|workspace):/u.test(coordinate)) {
      fail(`packed dependency ${name} retains a checkout-relative coordinate`);
    }
  }
  return manifestObject;
};

export const assertDevelopmentAssets = (entries: readonly string[]): void => {
  const required = [
    "examples/jungian-dialogue/README.md",
    "examples/jungian-dialogue/Simfile",
    "examples/jungian-dialogue/binding.mjs",
    "examples/jungian-dialogue/harness/jungian-engine.mjs",
    "examples/jungian-dialogue/org/Spawnfile",
    "examples/jungian-dialogue/org/agents/analyst/Spawnfile",
    "examples/jungian-dialogue/org/agents/daimon/Spawnfile",
    "dist/scripts/bounded-process.js",
    "dist/scripts/entrypoint.js",
    "dist/scripts/package-root.js",
    "dist/scripts/simfile-local-example.js",
    "dist/scripts/spawnfile-capability-probe.js",
    "dist/scripts/spawnfile-composed-smoke.js",
    "dist/scripts/spawnfile-development-context.js",
    "dist/scripts/spawnfile-development-setup.js",
    "dist/scripts/spawnfile-development.js",
    "dist/scripts/spawnfile-install-integrity.js",
    "dist/scripts/spawnfile-local-endpoint.js",
    "dist/scripts/spawnfile-source-stage.js",
    "dist/tools/package-closure-contract.js",
    "dist/tools/package-closure-install.js",
    "dist/tools/verify-package-closure.js",
  ];
  for (const entry of required) {
    if (!entries.includes(entry)) fail(`packed tarball omitted required development asset ${entry}`);
  }
  if (entries.some((entry) => entry.includes(".test.") || entry.includes(".test-helper."))) {
    fail("packed tarball leaked development test files");
  }
  if (entries.some((entry) => entry.startsWith("scripts/") || entry.startsWith("tools/"))) {
    fail("packed tarball leaked source tooling instead of emitted dist tooling");
  }
};

export const stelePackageName = STELE;
