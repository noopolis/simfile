import { lstat, mkdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { runBoundedProcess, type BoundedProcessResult } from "../scripts/bounded-process.ts";
import {
  fail,
  readJson,
  stelePackageName as STELE,
  STELE_VERSION,
  type PackageManifest,
} from "./package-closure-contract.ts";

type JsonObject = Record<string, unknown>;
type PrepareComposedProject = (input: Record<string, unknown>) => Promise<unknown>;

const isObject = (value: unknown): value is JsonObject =>
  value !== null && typeof value === "object" && !Array.isArray(value);

export const runPackageClosureProcess = (
  command: string,
  args: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<BoundedProcessResult> => runBoundedProcess(command, args, { cwd, env, timeoutMs: 10 * 60 * 1000 });

const dependencyRoot = async (installRoot: string, installedRoot: string): Promise<string> => {
  for (const candidate of [
    path.join(installedRoot, "node_modules", STELE),
    path.join(installRoot, "node_modules", STELE),
  ]) {
    try { await lstat(candidate); return candidate; }
    catch (error: unknown) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  return fail(`${STELE} was not installed from the packed Simfile dependency graph`);
};

const assertPackedExampleBuild = async (packedRoot: string, scratchRoot: string): Promise<string> => {
  const exampleRoot = path.join(packedRoot, "examples", "jungian-dialogue");
  const binding = await import(pathToFileURL(path.join(exampleRoot, "binding.mjs")).href) as {
    composedProjectBinding?: { prepareComposedProject?: unknown };
  };
  const prepare = binding.composedProjectBinding?.prepareComposedProject;
  if (typeof prepare !== "function") {
    fail("packed composed example binding is unavailable");
  }
  const preparation = await (prepare as PrepareComposedProject)({
    base_image_config_digest: `sha256:${"a".repeat(64)}`,
    evidence_root: path.join(scratchRoot, "example-evidence"), internal_port: 4070,
    organization_container_name: "package-closure-example",
    platform: { architecture: process.arch === "arm64" ? "arm64" : "amd64", os: "linux" },
    run_id: "package-closure-example", secret_root: path.join(scratchRoot, "example-secrets"),
    seed: "package-closure-example-seed", simfile_path: path.join(exampleRoot, "Simfile"),
    spawnfile_path: path.join(exampleRoot, "org", "Spawnfile"),
  }) as {
    bundle?: { archive_bytes?: unknown; manifest?: { digest?: unknown } };
    evidence_artifacts?: unknown[];
  };
  const bundle = preparation.bundle;
  if (bundle === undefined || !Array.isArray(bundle.archive_bytes) || bundle.archive_bytes.length < 1) {
    return fail("packed composed example bundle archive is empty");
  }
  const digest = bundle.manifest?.digest;
  if (typeof digest !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(digest)) {
    return fail("packed composed example bundle digest is invalid");
  }
  if (preparation.evidence_artifacts?.length !== 10) {
    return fail("packed composed example evidence mapping is incomplete");
  }
  return digest;
};

export const buildPackedExample = async (temporaryRoot: string, tarballPath: string): Promise<string> => {
  const packedRoot = path.join(temporaryRoot, "packed-package");
  const scratchRoot = path.join(temporaryRoot, "packed-example-scratch");
  await Promise.all([mkdir(packedRoot, { recursive: true }), mkdir(scratchRoot, { recursive: true })]);
  await runPackageClosureProcess(
    "tar", ["-xzf", tarballPath, "--strip-components=1", "-C", packedRoot], temporaryRoot,
  );
  await runPackageClosureProcess("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund",
    "--omit=dev", "--registry=https://registry.npmjs.org"], packedRoot);
  return assertPackedExampleBuild(await realpath(packedRoot), await realpath(scratchRoot));
};

const assertInstalledDevelopmentCommands = async (
  installRoot: string,
  installedRoot: string
): Promise<void> => {
  const probe = path.join(installRoot, "import-development-commands.mjs");
  const localExample = pathToFileURL(path.join(installedRoot, "dist/scripts/simfile-local-example.js")).href;
  const composedSmoke = pathToFileURL(path.join(installedRoot, "dist/scripts/spawnfile-composed-smoke.js")).href;
  const development = pathToFileURL(path.join(installedRoot, "dist/scripts/spawnfile-development.js")).href;
  await writeFile(probe, `
const local = await import(${JSON.stringify(localExample)});
const smoke = await import(${JSON.stringify(composedSmoke)});
const dev = await import(${JSON.stringify(development)});
const localInvocation = local.createLocalExampleInvocation("aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa");
const smokeInvocation = smoke.createComposedSmokeInvocation(["--context", "local_dev"], "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb");
if (!localInvocation.args[0].endsWith("/node_modules/simfile/dist/cli/index.js")) throw new Error("local example command did not resolve installed CLI");
if (!smokeInvocation.command_args[0].endsWith("/node_modules/simfile/dist/cli/index.js")) throw new Error("composed smoke command did not resolve installed CLI");
if (typeof dev.runSpawnfileDevelopmentCommand !== "function") throw new Error("development dispatcher export missing");
process.stdout.write("installed-development-commands-ok\\n");
`, "utf8");
  const result = await runPackageClosureProcess(process.execPath, [probe], installRoot);
  if (result.stdout !== "installed-development-commands-ok\n" || result.stderr !== "") {
    fail("installed emitted development commands did not import cleanly");
  }
};

export const assertInstalledClosure = async (
  installRoot: string,
  manifest: PackageManifest,
  tarballPath: string
): Promise<Readonly<{ steleResolved: string }>> => {
  await writeFile(path.join(installRoot, "package.json"), `${JSON.stringify({
    name: "simfile-package-closure-consumer", private: true, version: "1.0.0",
  }, null, 2)}\n`, "utf8");
  await runPackageClosureProcess("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund",
    "--registry=https://registry.npmjs.org", tarballPath], installRoot);
  if (typeof manifest.name !== "string") return fail("package manifest name is missing");
  const packageName = manifest.name;
  const installedRoot = path.join(installRoot, "node_modules", packageName);
  if ((await lstat(installedRoot)).isSymbolicLink()) fail("Simfile installed as a source link");
  const simfile = await import(pathToFileURL(path.join(installedRoot, "dist/index.js")).href) as {
    parseSimfileSource?: unknown;
  };
  if (typeof simfile.parseSimfileSource !== "function") fail("installed Simfile public import is incomplete");
  const steleRoot = await dependencyRoot(installRoot, installedRoot);
  if ((await lstat(steleRoot)).isSymbolicLink()) fail(`${STELE} installed as a source link`);
  const steleManifest = await readJson(path.join(steleRoot, "package.json"));
  if (!isObject(steleManifest) || steleManifest.version !== STELE_VERSION) return fail(`${STELE} installed version drifted`);
  const steleManifestObject = steleManifest;
  const steleExports = isObject(steleManifestObject.exports) ? steleManifestObject.exports : undefined;
  const rootExport = steleExports !== undefined && isObject(steleExports["."]) ? steleExports["."] : undefined;
  const steleImport = rootExport?.import;
  if (typeof steleImport !== "string" || !steleImport.startsWith("./")) {
    return fail(`${STELE} does not expose a package-relative ESM entrypoint`);
  }
  const steleImportPath = steleImport;
  const installRealRoot = await realpath(installRoot);
  const steleRealPath = await realpath(path.resolve(steleRoot, steleImportPath));
  if (!steleRealPath.startsWith(`${installRealRoot}${path.sep}`)) {
    fail(`${STELE} resolved outside the isolated install`);
  }
  const stele = await import(pathToFileURL(steleRealPath).href) as { parseCausalJsonl?: unknown };
  if (typeof stele.parseCausalJsonl !== "function") fail(`${STELE} runtime import is incomplete`);
  const simfileBin = manifest.bin?.simfile;
  if (typeof simfileBin !== "string") {
    return fail("package manifest is missing the simfile executable");
  }
  const simfileBinPath = simfileBin;
  const executable = path.join(installRoot, "node_modules", ".bin", "simfile");
  const help = await runPackageClosureProcess(executable, ["--help"], installRoot, {
    ...process.env, PATH: `${path.dirname(executable)}${path.delimiter}${process.env.PATH ?? ""}`,
  });
  if (!help.stdout.startsWith("Usage:\n") || !help.stdout.includes("simfile run <path>")) {
    fail("installed Simfile executable did not invoke the CLI entrypoint");
  }
  const importProbe = path.join(installRoot, "import-cli.mjs");
  const installedCli = path.join(installedRoot, simfileBinPath);
  await writeFile(importProbe, `await import(${JSON.stringify(pathToFileURL(installedCli).href)});\nprocess.stdout.write("import-only-ok\\n");\n`, "utf8");
  const imported = await runPackageClosureProcess(process.execPath, [importProbe], installRoot);
  if (imported.stdout !== "import-only-ok\n" || imported.stderr !== "") {
    fail("importing the installed CLI produced entrypoint side effects");
  }
  await assertInstalledDevelopmentCommands(installRoot, installedRoot);
  return { steleResolved: path.relative(installRealRoot, steleRealPath) };
};
