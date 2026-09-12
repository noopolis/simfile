import { randomUUID } from "node:crypto";
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import {
  currentPath,
  developmentRoot,
  fail,
  installsRoot,
  probeSpawnfileCapabilities,
  run,
  STATE_VERSION,
} from "./spawnfile-development-context.ts";
import { stagePhysicalSpawnfileSource } from "./spawnfile-source-stage.ts";
import {
  assertInstalledArtifact,
  hash,
  type InstalledArtifactExpectation,
  packagedTarballAt,
  probeIdentity,
} from "./spawnfile-install-integrity.ts";

type SetupOptions = Readonly<{
  artifact?: string;
  packageSpec?: string;
  sha256?: string;
  source?: string;
}>;

type PackSelection = Readonly<{
  identity: string;
  installSpec: string;
  origin:
    | Readonly<{ kind: "artifact"; package_version: string; path: string; sha256: string }>
    | Readonly<{ kind: "registry"; package_version: string; spec: string | undefined }>
    | Readonly<{ kind: "source"; package_version: string; path: string }>;
  tarball: string;
  tarball_sha256: string;
}>;

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

export const parseSetupArguments = (args: readonly string[]): SetupOptions => {
  let source: string | undefined;
  let packageSpec: string | undefined;
  let artifact: string | undefined;
  let sha256: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (!["--artifact", "--package", "--sha256", "--source"].includes(flag)) {
      fail(`Unknown setup option ${flag ?? ""}`.trim());
    }
    const value = args[index + 1];
    if (!value || value.startsWith("--")) fail(`${flag} requires a value`);
    if (flag === "--source") source = value;
    else if (flag === "--package") packageSpec = value;
    else if (flag === "--artifact") artifact = value;
    else sha256 = value;
    index += 1;
  }
  if ([source, packageSpec, artifact].filter((value) => value !== undefined).length !== 1) {
    fail("Setup requires exactly one of --source, --package, or --artifact");
  }
  if (source !== undefined && (!path.isAbsolute(source) || path.normalize(source) !== source)) {
    fail("--source must be an absolute normalized Spawnfile checkout path");
  }
  if (packageSpec !== undefined
    && !/^spawnfile@[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$/u.test(packageSpec)) {
    fail("--package must be an exact spawnfile@<version> coordinate");
  }
  if (artifact !== undefined && (!path.isAbsolute(artifact) || path.normalize(artifact) !== artifact)) {
    fail("--artifact must be an absolute normalized Spawnfile tarball path");
  }
  if (artifact !== undefined && !/^[0-9a-f]{64}$/u.test(sha256 ?? "")) {
    fail("--artifact requires --sha256 with an exact lowercase SHA-256 digest");
  }
  if (artifact === undefined && sha256 !== undefined) fail("--sha256 is valid only with --artifact");
  return { artifact, packageSpec, sha256, source };
};

const parsePackResult = (stdout: string): { filename: string; integrity: string; version: string } => {
  let value: unknown;
  try { value = JSON.parse(stdout); }
  catch { return fail("npm pack did not return JSON"); }
  if (!Array.isArray(value) || value.length !== 1 || !isObject(value[0])
    || typeof value[0].filename !== "string" || typeof value[0].integrity !== "string"
    || typeof value[0].version !== "string") {
    return fail("npm pack did not report exactly one Spawnfile tarball");
  }
  return { filename: value[0].filename, integrity: value[0].integrity, version: value[0].version };
};

const installPackage = async (spec: string, temporaryRoot: string): Promise<void> => {
  await writeFile(path.join(temporaryRoot, "package.json"), `${JSON.stringify({
    name: "simfile-spawnfile-development-tool", private: true, version: "0.0.0",
  }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund",
    "--no-package-lock", "--save-exact", spec], { cwd: temporaryRoot });
};

const packedSelection = async (input: SetupOptions, temporaryRoot: string): Promise<PackSelection> => {
  if (input.artifact !== undefined) {
    const info = await lstat(input.artifact).catch(() => fail("Spawnfile artifact is missing"));
    if (!info.isFile() || info.isSymbolicLink()) fail("Spawnfile artifact must be a regular file");
    const tarballHash = hash(await readFile(input.artifact));
    if (tarballHash !== input.sha256) fail("Spawnfile artifact SHA-256 did not match --sha256");
    const manifestText = (await run("tar", ["-xOf", input.artifact, "package/package.json"])).stdout;
    let manifest: unknown;
    try { manifest = JSON.parse(manifestText); } catch { return fail("Spawnfile artifact package metadata is invalid"); }
    if (!isObject(manifest) || manifest.name !== "spawnfile" || typeof manifest.version !== "string") {
      return fail("Spawnfile artifact is not a versioned spawnfile package");
    }
    const packageVersion = manifest.version;
    return { identity: `artifact-v1:${tarballHash}`, installSpec: input.artifact,
      origin: { kind: "artifact", package_version: packageVersion,
        path: input.artifact, sha256: tarballHash },
      tarball: input.artifact, tarball_sha256: tarballHash };
  }
  let packCwd: string | undefined;
  let packSpec: string | undefined;
  let origin: PackSelection["origin"] | undefined;
  if (input.source !== undefined) {
    const staged = await stagePhysicalSpawnfileSource(input.source, temporaryRoot);
    await run("npm", ["ci", "--no-audit", "--no-fund"], { cwd: staged.staging });
    await run("npm", ["run", "build"], { cwd: staged.staging });
    packCwd = staged.staging;
    origin = { kind: "source", package_version: staged.origin.package_version,
      path: staged.origin.path };
  } else {
    if (input.packageSpec === undefined) return fail("Setup requires exactly one of --source, --package, or --artifact");
    packSpec = input.packageSpec;
  }
  const packRoot = path.join(temporaryRoot, "pack");
  await mkdir(packRoot, { mode: 0o700 });
  const args = ["pack", ...(packSpec === undefined ? [] : [packSpec]),
    "--json", "--pack-destination", packRoot];
  const packed = parsePackResult((await run("npm", args,
    packCwd === undefined ? {} : { cwd: packCwd })).stdout);
  const tarball = path.join(packRoot, packed.filename);
  const tarballHash = hash(await readFile(tarball));
  return { identity: `${input.source === undefined ? "registry" : "source"}-v2:${tarballHash}`,
    installSpec: tarball,
    origin: origin ?? { kind: "registry", package_version: packed.version, spec: packSpec },
    tarball, tarball_sha256: tarballHash };
};

const writeCurrentState = async (state: unknown): Promise<void> => {
  await mkdir(developmentRoot, { recursive: true, mode: 0o700 });
  const pending = path.join(developmentRoot, `.current-${randomUUID()}.json`);
  await writeFile(pending, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(pending, currentPath);
};

export const setupSpawnfileDevelopment = async (args: readonly string[]): Promise<void> => {
  const options = parseSetupArguments(args);
  await mkdir(installsRoot, { recursive: true, mode: 0o700 });
  const temporaryRoot = await mkdtemp(path.join(developmentRoot, ".install-"));
  try {
    const selected = await packedSelection(options, temporaryRoot);
    const installRoot = path.join(installsRoot, hash(selected.identity).slice(0, 32));
    try { await lstat(installRoot); }
    catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const staged = path.join(temporaryRoot, "installed");
      await mkdir(staged, { mode: 0o700 });
      await installPackage(selected.installSpec, staged);
      await copyFile(selected.tarball, packagedTarballAt(staged), 0);
      await assertInstalledArtifact(staged, { package_version: selected.origin.package_version,
        repair_permissions: true, tarball_sha256: selected.tarball_sha256 });
      await rename(staged, installRoot);
    }
    const installed = await assertInstalledArtifact(installRoot, {
      package_version: selected.origin.package_version,
      tarball_sha256: selected.tarball_sha256,
    } satisfies InstalledArtifactExpectation);
    const probe = await probeSpawnfileCapabilities(installed.executable);
    if (!probe.development.ready) fail("Installed Spawnfile lacks required generic development commands");
    const state = { bin: installed.executable, capability_probe: probeIdentity(probe),
      implementation: { executable_sha256: installed.executable_sha256,
        installed_closure_sha256: installed.installed_closure_sha256,
        package_version: installed.package_version, tarball_sha256: installed.tarball_sha256 },
      install_root: installRoot, origin: selected.origin, version: STATE_VERSION };
    await writeCurrentState(state);
    process.stdout.write(`${JSON.stringify({ ...state, capability_probe: probe,
      capability_probe_identity: state.capability_probe }, null, 2)}\n`);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
};
