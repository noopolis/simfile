import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  runSpawnfileCompile,
  runSpawnfileProvisionCredentials,
  runSpawnfileRevokeCredentialSource,
} from "./bootstrapCli.js";
import { captureBootstrapLocalExecutableIdentity } from "./process.js";

const opaque = (character: string): `opaque_${string}` => `opaque_${character.repeat(16)}`;

const writeFakeSpawnfile = async (root: string): Promise<string> => {
  const file = path.join(root, "fake-spawnfile.mjs");
  await writeFile(file, `#!/usr/bin/env node
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
const argv = process.argv.slice(2); const request = argv.at(-1)?.endsWith(".json")
  ? JSON.parse(await readFile(argv.at(-1), "utf8")) : undefined;
await appendFile(process.env.CAPTURE_FILE, JSON.stringify({ argv, request }) + "\\n");
if (argv[0] === "compile") { const out = argv[argv.indexOf("--out") + 1]; await mkdir(out, { recursive: true }); await writeFile(out + "/spawnfile-report.json", JSON.stringify({ compiled: true })); }
if (argv[0] === "auth" && argv[1] === "provision") process.stdout.write(JSON.stringify({ credentials: [{ env: "WORLD_TOKEN", name: "world_token", scope: "world", source_handle: "opaque_${"d".repeat(16)}" }], env_file_digest: "sha256:${"4".repeat(64)}", phases: ["author", "grant"], run_id: "run-one", scope: "world", version: "spawnfile.auth.credential-provisioning.receipt.v1", world_bindings_digest: "sha256:${"5".repeat(64)}" }) + "\\n");
if (argv[0] === "auth" && argv[1] === "target-secret") process.stdout.write(JSON.stringify({ kind: argv[2], source_handle: request.source_handle, version: "spawnfile.auth.target-secret.receipt.v1" }) + "\\n");
`, { mode: 0o700 });
  return file;
};

test("bootstrap wrappers retain compile and credential cleanup without a target-helper ABI", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "simfile-bootstrap-cli-"));
  try {
    const capture = path.join(root, "capture.jsonl");
    const spawnfileBin = await writeFakeSpawnfile(root);
    const context = { bootstrapLocalExecutableIdentity: await captureBootstrapLocalExecutableIdentity(spawnfileBin),
      env: { ...process.env, CAPTURE_FILE: capture }, spawnfileBin };
    const envFile = path.join(root, "organization.env");
    const grantsFile = path.join(root, "grants.json");
    const bindingsFile = path.join(root, "bindings.json");
    await Promise.all([envFile, grantsFile, bindingsFile].map((file) => writeFile(file, "{}")));
    const auth = await runSpawnfileProvisionCredentials(context, {
      env_file: envFile, request: { version: "request" }, resolved_grants_file: grantsFile,
      world_bindings_file: bindingsFile,
    });
    await runSpawnfileRevokeCredentialSource(context, { source_handle: opaque("d") });
    const compiled = path.join(root, "compiled");
    assert.deepEqual(await runSpawnfileCompile(context, {
      compiled_output_directory: compiled, organization_path: "/project/Spawnfile",
    }), { compiled: true });
    assert.equal(auth.credentials[0]?.source_handle, opaque("d"));
    const calls = (await readFile(capture, "utf8")).trim().split("\n")
      .map((line) => JSON.parse(line) as { argv: string[] });
    assert.deepEqual(calls.map(({ argv }) => argv.slice(0, 2)), [
      ["auth", "provision"], ["auth", "target-secret"], ["auth", "target-secret"], ["compile", "/project/Spawnfile"],
    ]);
  } finally { await rm(root, { force: true, recursive: true }); }
});
