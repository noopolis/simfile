import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  runSpawnfileCompile,
  runSpawnfileDeriveBundlePolicy,
  runSpawnfilePrepareContainerBundle,
  runSpawnfileProvisionCredentials,
  runSpawnfileRevokeCredentialSource,
  runSpawnfileSelectTarget,
} from "./bootstrapCli.js";

const sha = (character: string): `sha256:${string}` =>
  `sha256:${character.repeat(64)}`;
const opaque = (character: string): `opaque_${string}` =>
  `opaque_${character.repeat(16)}`;

const writeFakeSpawnfile = async (root: string): Promise<string> => {
  const file = path.join(root, "fake-spawnfile.mjs");
  await writeFile(file, `#!/usr/bin/env node
import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
const argv = process.argv.slice(2);
let stdin = ""; process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) stdin += chunk;
const canonical = (value) => Array.isArray(value)
  ? "[" + value.map(canonical).join(",") + "]"
  : value !== null && typeof value === "object"
    ? "{" + Object.keys(value).sort().map((key) => JSON.stringify(key) + ":" + canonical(value[key])).join(",") + "}"
    : JSON.stringify(value);
const digest = (domain, value) => "sha256:" + createHash("sha256")
  .update("spawnfile.target-local-container-bundle." + domain + ".v1\\0")
  .update(canonical(value)).digest("hex");
const requestFile = argv.at(-1);
const request = requestFile?.endsWith(".json")
  ? JSON.parse(await readFile(requestFile, "utf8")) : undefined;
await appendFile(process.env.CAPTURE_FILE, JSON.stringify({ argv, stdin,
  request_size: requestFile?.endsWith(".json") ? (await readFile(requestFile)).byteLength : null }) + "\\n");
let output;
if (argv[0] === "compile") {
  const out = argv[argv.indexOf("--out") + 1]; await mkdir(out, { recursive: true });
  await writeFile(new URL("spawnfile-report.json", "file://" + out + "/"), JSON.stringify({ compiled: true }));
} else if (argv[3] === "select_target") output = {
  fingerprint: "sha256:" + "1".repeat(32), handle: "opaque_" + "a".repeat(16),
  version: "spawnfile.target-resource.selected-target.v1",
};
else if (argv[3] === "derive_container_bundle_policy") output = {
  build_policy_digest: "sha256:" + "2".repeat(64),
  platform_digest: "sha256:" + "3".repeat(64),
  version: "spawnfile.target-local-container-bundle-policy.v1",
};
else if (argv[3] === "prepare_container_bundle") {
  const body = {
    archive_digest: request.archive_digest, artifact_digest: request.artifact_digest,
    build_policy_digest: request.build_policy_digest, bundle_digest: request.bundle_digest,
    launcher_digest: request.launcher_digest, mapping_handle: "opaque_" + "b".repeat(16),
    network_alias: request.network_alias, operation_handle: "opaque_" + "c".repeat(16),
    platform: request.platform, platform_digest: request.platform_digest,
    request_digest: digest("request", request), selected_target: request.selected_target,
    version: "spawnfile.target-local-container-bundle.prepare-receipt.v1",
  };
  output = { ...body, receipt_digest: process.env.BAD_RECEIPT === "1"
    ? "sha256:" + "0".repeat(64) : digest("receipt", body) };
} else if (argv[0] === "auth" && argv[1] === "provision") output = {
  credentials: [{ env: "WORLD_TOKEN", name: "world_token", scope: "world",
    source_handle: "opaque_" + "d".repeat(16) }],
  env_file_digest: "sha256:" + "4".repeat(64), phases: ["author", "grant"],
  run_id: "run-one", scope: "world",
  version: "spawnfile.auth.credential-provisioning.receipt.v1",
  world_bindings_digest: "sha256:" + "5".repeat(64),
}; else if (argv[0] === "auth" && argv[1] === "target-secret") output = {
  kind: argv[2], source_handle: request.source_handle,
  version: "spawnfile.auth.target-secret.receipt.v1",
};
if (process.env.FAIL_REVOKE_GRANT === "1" && argv[2] === "revoke-grant") output.kind = "wrong";
if (output !== undefined) process.stdout.write(JSON.stringify(output) + "\\n");
`, { mode: 0o700 });
  return file;
};

test("bootstrap wrappers preserve public Spawnfile boundaries and a large bundle envelope", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "simfile-bootstrap-cli-"));
  try {
    const capture = path.join(root, "capture.jsonl");
    const context = { env: { ...process.env, CAPTURE_FILE: capture },
      spawnfileBin: await writeFakeSpawnfile(root) };
    const targetConfig = new TextEncoder().encode("PRIVATE_TARGET_CONFIG");
    assert.deepEqual(await runSpawnfileSelectTarget(context, {
      request: { operation: "select" }, target_config_stdin: targetConfig,
    }), { fingerprint: `sha256:${"1".repeat(32)}`, handle: opaque("a"),
      version: "spawnfile.target-resource.selected-target.v1" });
    assert.deepEqual(await runSpawnfileDeriveBundlePolicy(context, { architecture: "amd64" }), {
      build_policy_digest: sha("2"), platform_digest: sha("3"),
      version: "spawnfile.target-local-container-bundle-policy.v1",
    });
    const archive = Buffer.alloc(512 * 1024, 7);
    const request = {
      archive_base64: archive.toString("base64"), archive_digest: sha("6"),
      archive_entries: ["entrypoint.mjs"], artifact_digest: sha("7"),
      build_policy_digest: sha("2"), bundle_digest: sha("8"),
      entrypoint: "entrypoint.mjs", idempotency_key: `idem_${"a".repeat(16)}`,
      launcher_digest: sha("9"), network_alias: "world", platform: {
        architecture: "amd64" as const, os: "linux" as const,
      }, platform_digest: sha("3"), selected_target: {
        fingerprint: `sha256:${"1".repeat(32)}`, handle: opaque("a"),
      }, version: "spawnfile.target-local-container-bundle.prepare-request.v1" as const,
    };
    const bundle = await runSpawnfilePrepareContainerBundle(context, {
      request, target_config_stdin: targetConfig,
    });
    assert.equal(bundle.bundle_digest, request.bundle_digest);
    assert.equal(bundle.selected_target.handle, request.selected_target.handle);
    const envFile = path.join(root, "organization.env");
    const grantsFile = path.join(root, "grants.json");
    const bindingsFile = path.join(root, "bindings.json");
    await Promise.all([envFile, grantsFile, bindingsFile].map((file) => writeFile(file, "{}")));
    const auth = await runSpawnfileProvisionCredentials(context, {
      env_file: envFile, request: { version: "request" }, resolved_grants_file: grantsFile,
      world_bindings_file: bindingsFile,
    });
    assert.equal(auth.credentials[0]?.source_handle, opaque("d"));
    await runSpawnfileRevokeCredentialSource(context, { source_handle: opaque("d") });
    const compiled = path.join(root, "compiled");
    assert.deepEqual(await runSpawnfileCompile(context, {
      compiled_output_directory: compiled, organization_path: "/project/Spawnfile",
    }), { compiled: true });
    const calls = (await readFile(capture, "utf8")).trim().split("\n")
      .map((line) => JSON.parse(line) as { argv: string[]; request_size: number; stdin: string });
    assert.deepEqual(calls.map(({ argv }) => argv.slice(0, 4)), [
      ["target", "--config", "-", "select_target"],
      ["target", "--config", "-", "derive_container_bundle_policy"],
      ["target", "--config", "-", "prepare_container_bundle"],
      ["auth", "provision", calls[3]!.argv[2]!, "--env-file"],
      ["auth", "target-secret", "revoke-grant", calls[4]!.argv[3]!],
      ["auth", "target-secret", "revoke-version", calls[5]!.argv[3]!],
      ["compile", "/project/Spawnfile", "--out", compiled],
    ]);
    assert.equal(calls[0]!.stdin, "PRIVATE_TARGET_CONFIG");
    assert.equal(calls[1]!.stdin, "{}");
    assert.equal(calls[2]!.stdin, "PRIVATE_TARGET_CONFIG");
    assert.ok(calls[2]!.request_size > 512 * 1024);
  } finally { await rm(root, { force: true, recursive: true }); }
});

test("bundle wrapper rejects receipt correlation drift without exposing target config", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "simfile-bootstrap-drift-"));
  try {
    const context = { env: { ...process.env, BAD_RECEIPT: "1",
      CAPTURE_FILE: path.join(root, "capture.jsonl") }, spawnfileBin: await writeFakeSpawnfile(root) };
    const request = {
      archive_base64: Buffer.from("archive").toString("base64"), archive_digest: sha("6"),
      archive_entries: ["entrypoint.mjs"], artifact_digest: sha("7"),
      build_policy_digest: sha("2"), bundle_digest: sha("8"), entrypoint: "entrypoint.mjs",
      idempotency_key: `idem_${"a".repeat(16)}`, launcher_digest: sha("9"),
      network_alias: "world", platform: { architecture: "amd64", os: "linux" },
      platform_digest: sha("3"), selected_target: {
        fingerprint: `sha256:${"1".repeat(32)}`, handle: opaque("a"),
      }, version: "spawnfile.target-local-container-bundle.prepare-request.v1",
    } as const;
    await assert.rejects(runSpawnfilePrepareContainerBundle(context, {
      request, target_config_stdin: new TextEncoder().encode("PRIVATE_TARGET_CONFIG"),
    }), (error: Error) => /correlation is invalid/u.test(error.message)
      && !error.message.includes("PRIVATE_TARGET_CONFIG"));
  } finally { await rm(root, { force: true, recursive: true }); }
});

test("credential cleanup attempts version revocation after a grant-revocation failure", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "simfile-bootstrap-revoke-"));
  try {
    const capture = path.join(root, "capture.jsonl");
    const context = { env: { ...process.env, CAPTURE_FILE: capture,
      FAIL_REVOKE_GRANT: "1" }, spawnfileBin: await writeFakeSpawnfile(root) };
    await assert.rejects(runSpawnfileRevokeCredentialSource(context, {
      source_handle: opaque("d"),
    }), /source revocation is incomplete/u);
    const calls = (await readFile(capture, "utf8")).trim().split("\n")
      .map((line) => (JSON.parse(line) as { argv: string[] }).argv[2]);
    assert.deepEqual(calls, ["revoke-grant", "revoke-version"]);
  } finally { await rm(root, { force: true, recursive: true }); }
});
