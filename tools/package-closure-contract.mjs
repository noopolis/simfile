import { lstat, readFile } from "node:fs/promises";
import path from "node:path";

const STELE = "@noopolis/stele";
export const STELE_VERSION = "0.0.2";

export const fail = (message) => { throw new Error(message); };
export const readJson = async (filePath) => JSON.parse(await readFile(filePath, "utf8"));

export const parseSinglePack = (stdout) => {
  let parsed;
  for (let index = stdout.lastIndexOf("["); index >= 0;
    index = stdout.lastIndexOf("[", index - 1)) {
    try {
      const candidate = JSON.parse(stdout.slice(index));
      if (Array.isArray(candidate)) { parsed = candidate; break; }
    } catch {
      // Lifecycle scripts may write before npm's final JSON array.
    }
  }
  if (!Array.isArray(parsed) || parsed.length !== 1) {
    fail("npm pack must report exactly one tarball");
  }
  const [result] = parsed;
  if (!result || typeof result.filename !== "string" || !Array.isArray(result.files)) {
    fail("npm pack returned an invalid manifest");
  }
  return result;
};

export const assertRegistrySource = async (packageRoot, manifest, lock) => {
  if (manifest.dependencies?.[STELE] !== STELE_VERSION) {
    fail(`${STELE} must use the published ${STELE_VERSION} release coordinate`);
  }
  if (manifest.bundledDependencies !== undefined || manifest.bundleDependencies !== undefined) {
    fail("published registry dependencies must not be bundled");
  }
  for (const [name, coordinate] of Object.entries(manifest.dependencies ?? {})) {
    if (typeof coordinate !== "string" || /^(?:file|link|workspace):/u.test(coordinate)) {
      fail(`runtime dependency ${name} is not a registry coordinate`);
    }
  }
  for (const [location, entry] of Object.entries(lock.packages ?? {})) {
    if (location === "") continue;
    if (entry?.link === true
      || (typeof entry?.resolved === "string" && /^(?:file|link):/u.test(entry.resolved))) {
      fail(`package lock contains a checkout-relative dependency at ${location}`);
    }
  }
  const locked = lock.packages?.[`node_modules/${STELE}`];
  const expected = `https://registry.npmjs.org/@noopolis/stele/-/stele-${STELE_VERSION}.tgz`;
  if (!locked || locked.version !== STELE_VERSION || locked.resolved !== expected) {
    fail(`${STELE} lock entry must resolve to the exact npm registry tarball`);
  }
  if (typeof locked.integrity !== "string" || !locked.integrity.startsWith("sha512-")) {
    fail(`${STELE} registry lock is missing sha512 integrity`);
  }
  const installed = path.join(packageRoot, "node_modules", STELE);
  if ((await lstat(installed)).isSymbolicLink()) {
    fail(`${STELE} must be physically installed; source-checkout links are rejected`);
  }
  if ((await readJson(path.join(installed, "package.json"))).version !== STELE_VERSION) {
    fail(`${STELE} installed version drifted`);
  }
  return expected;
};

export const assertPackedManifest = (manifest) => {
  if (manifest.version !== "0.0.3") fail("packed Simfile version drifted");
  if (manifest.dependencies?.[STELE] !== STELE_VERSION) fail(`packed ${STELE} coordinate drifted`);
  if (manifest.bundledDependencies !== undefined || manifest.bundleDependencies !== undefined) {
    fail("packed manifest unexpectedly bundles registry dependencies");
  }
  for (const [name, coordinate] of Object.entries(manifest.dependencies ?? {})) {
    if (typeof coordinate === "string" && /^(?:file|link|workspace):/u.test(coordinate)) {
      fail(`packed dependency ${name} retains a checkout-relative coordinate`);
    }
  }
};

export const assertDevelopmentAssets = (entries) => {
  const required = [
    "examples/jungian-dialogue/README.md",
    "examples/jungian-dialogue/Simfile",
    "examples/jungian-dialogue/binding.mjs",
    "examples/jungian-dialogue/harness/jungian-engine.mjs",
    "examples/jungian-dialogue/org/Spawnfile",
    "examples/jungian-dialogue/org/agents/analyst/Spawnfile",
    "examples/jungian-dialogue/org/agents/daimon/Spawnfile",
    "scripts/bounded-process.mjs",
    "scripts/simfile-local-example.mjs",
    "scripts/spawnfile-capability-probe.mjs",
    "scripts/spawnfile-composed-smoke.mjs",
    "scripts/spawnfile-development-context.mjs",
    "scripts/spawnfile-development-setup.mjs",
    "scripts/spawnfile-development.mjs",
    "scripts/spawnfile-install-integrity.mjs",
    "scripts/spawnfile-local-endpoint.mjs",
    "scripts/spawnfile-source-stage.mjs",
  ];
  for (const entry of required) {
    if (!entries.includes(entry)) fail(`packed tarball omitted required development asset ${entry}`);
  }
  if (entries.some((entry) => entry.includes(".test.") || entry.includes(".test-helper."))) {
    fail("packed tarball leaked development test files");
  }
};

export const stelePackageName = STELE;
