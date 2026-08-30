import { lstat, mkdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { runBoundedProcess } from "../scripts/bounded-process.mjs";
import {
  fail,
  readJson,
  stelePackageName as STELE,
  STELE_VERSION,
} from "./package-closure-contract.mjs";

export const runPackageClosureProcess = (
  command, args, cwd, env = process.env,
) => runBoundedProcess(command, args, { cwd, env, timeoutMs: 10 * 60 * 1000 });

const dependencyRoot = async (installRoot, installedRoot) => {
  for (const candidate of [
    path.join(installedRoot, "node_modules", STELE),
    path.join(installRoot, "node_modules", STELE),
  ]) {
    try { await lstat(candidate); return candidate; }
    catch (error) { if (error?.code !== "ENOENT") throw error; }
  }
  fail(`${STELE} was not installed from the packed Simfile dependency graph`);
};

const assertPackedExampleBuild = async (packedRoot, scratchRoot) => {
  const exampleRoot = path.join(packedRoot, "examples", "jungian-dialogue");
  const binding = await import(pathToFileURL(path.join(exampleRoot, "binding.mjs")).href);
  if (typeof binding.composedProjectBinding?.prepareComposedProject !== "function") {
    fail("packed composed example binding is unavailable");
  }
  const preparation = await binding.composedProjectBinding.prepareComposedProject({
    base_image_config_digest: `sha256:${"a".repeat(64)}`,
    evidence_root: path.join(scratchRoot, "example-evidence"), internal_port: 4070,
    organization_container_name: "package-closure-example",
    platform: { architecture: process.arch === "arm64" ? "arm64" : "amd64", os: "linux" },
    run_id: "package-closure-example", secret_root: path.join(scratchRoot, "example-secrets"),
    seed: "package-closure-example-seed", simfile_path: path.join(exampleRoot, "Simfile"),
    spawnfile_path: path.join(exampleRoot, "org", "Spawnfile"),
  });
  if (!Array.isArray(preparation.bundle?.archive_bytes)
    || preparation.bundle.archive_bytes.length < 1) fail("packed composed example bundle archive is empty");
  if (!/^sha256:[a-f0-9]{64}$/u.test(preparation.bundle.manifest?.digest ?? "")) {
    fail("packed composed example bundle digest is invalid");
  }
  if (preparation.evidence_artifacts?.length !== 10) {
    fail("packed composed example evidence mapping is incomplete");
  }
  return preparation.bundle.manifest.digest;
};

export const buildPackedExample = async (temporaryRoot, tarballPath) => {
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

export const assertInstalledClosure = async (installRoot, manifest, tarballPath) => {
  await writeFile(path.join(installRoot, "package.json"), `${JSON.stringify({
    name: "simfile-package-closure-consumer", private: true, version: "1.0.0",
  }, null, 2)}\n`, "utf8");
  await runPackageClosureProcess("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund",
    "--registry=https://registry.npmjs.org", tarballPath], installRoot);
  const installedRoot = path.join(installRoot, "node_modules", manifest.name);
  if ((await lstat(installedRoot)).isSymbolicLink()) fail("Simfile installed as a source link");
  const simfile = await import(pathToFileURL(path.join(installedRoot, "dist/index.js")).href);
  if (typeof simfile.parseSimfileSource !== "function") fail("installed Simfile public import is incomplete");
  const steleRoot = await dependencyRoot(installRoot, installedRoot);
  if ((await lstat(steleRoot)).isSymbolicLink()) fail(`${STELE} installed as a source link`);
  const steleManifest = await readJson(path.join(steleRoot, "package.json"));
  if (steleManifest.version !== STELE_VERSION) fail(`${STELE} installed version drifted`);
  const steleImport = steleManifest.exports?.["."]?.import;
  if (typeof steleImport !== "string" || !steleImport.startsWith("./")) {
    fail(`${STELE} does not expose a package-relative ESM entrypoint`);
  }
  const installRealRoot = await realpath(installRoot);
  const steleRealPath = await realpath(path.resolve(steleRoot, steleImport));
  if (!steleRealPath.startsWith(`${installRealRoot}${path.sep}`)) {
    fail(`${STELE} resolved outside the isolated install`);
  }
  const stele = await import(pathToFileURL(steleRealPath).href);
  if (typeof stele.parseCausalJsonl !== "function") fail(`${STELE} runtime import is incomplete`);
  const executable = path.join(installRoot, "node_modules", ".bin", "simfile");
  const help = await runPackageClosureProcess(executable, ["--help"], installRoot, {
    ...process.env, PATH: `${path.dirname(executable)}${path.delimiter}${process.env.PATH ?? ""}`,
  });
  if (!help.stdout.startsWith("Usage:\n") || !help.stdout.includes("simfile run <path>")) {
    fail("installed Simfile executable did not invoke the CLI entrypoint");
  }
  const importProbe = path.join(installRoot, "import-cli.mjs");
  const installedCli = path.join(installedRoot, manifest.bin.simfile);
  await writeFile(importProbe, `await import(${JSON.stringify(pathToFileURL(installedCli).href)});\nprocess.stdout.write("import-only-ok\\n");\n`, "utf8");
  const imported = await runPackageClosureProcess(process.execPath, [importProbe], installRoot);
  if (imported.stdout !== "import-only-ok\n" || imported.stderr !== "") {
    fail("importing the installed CLI produced entrypoint side effects");
  }
  return { steleResolved: path.relative(installRealRoot, steleRealPath) };
};
