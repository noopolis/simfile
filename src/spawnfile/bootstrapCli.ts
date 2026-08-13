import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { z } from "zod";

import { canonicalComposedJson } from "../compose/json.js";
import { runSpawnfileProcess, type SpawnfileCliContext } from "./process.js";

const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const handle = z.string().regex(/^opaque_[a-z0-9]{16,64}$/u);
const selectedTargetSchema = z.object({
  fingerprint: z.string().regex(/^sha256:[a-f0-9]{32}$/u),
  handle,
  version: z.literal("spawnfile.target-resource.selected-target.v1"),
}).strict();
const selectedTargetIdentitySchema = selectedTargetSchema.omit({ version: true });
const policySchema = z.object({
  build_policy_digest: digest,
  platform_digest: digest,
  version: z.literal("spawnfile.target-local-container-bundle-policy.v1"),
}).strict();
const bundleReceiptSchema = z.object({
  archive_digest: digest,
  artifact_digest: digest,
  build_policy_digest: digest,
  bundle_digest: digest,
  launcher_digest: digest,
  mapping_handle: handle,
  network_alias: z.string().regex(/^[a-z][a-z0-9-]{0,62}$/u),
  operation_handle: handle,
  platform: z.object({ architecture: z.enum(["amd64", "arm64"]),
    os: z.literal("linux") }).strict(),
  platform_digest: digest,
  receipt_digest: digest,
  request_digest: digest,
  selected_target: selectedTargetIdentitySchema,
  version: z.literal("spawnfile.target-local-container-bundle.prepare-receipt.v1"),
}).strict();
const provisionReceiptSchema = z.object({
  credentials: z.array(z.object({ env: z.string(), name: z.string(), scope: z.string(),
    source_handle: handle }).strict()).min(1).max(64),
  env_file_digest: digest,
  phases: z.array(z.enum(["author", "grant", "model_engine_auth", "env_file",
    "world_bindings"])).min(2).max(5),
  run_id: z.string().min(1),
  scope: z.string().min(1),
  version: z.literal("spawnfile.auth.credential-provisioning.receipt.v1"),
  world_bindings_digest: digest,
}).strict();
const bundleRequestSchema = z.object({
  archive_base64: z.string().max(5_592_408).refine((value) => {
    if (value.length % 4 !== 0) return false;
    const bytes = Buffer.from(value, "base64");
    return bytes.byteLength <= 4_194_304 && bytes.toString("base64") === value;
  }),
  archive_digest: digest,
  archive_entries: z.array(z.string().min(1).max(256)).min(1).max(32),
  artifact_digest: digest,
  build_policy_digest: digest,
  bundle_digest: digest,
  entrypoint: z.string().min(1).max(256),
  idempotency_key: z.string().regex(/^idem_[a-z0-9]{16,64}$/u),
  launcher_digest: digest,
  network_alias: z.string().regex(/^[a-z][a-z0-9-]{0,62}$/u),
  platform: z.object({ architecture: z.enum(["amd64", "arm64"]),
    os: z.literal("linux") }).strict(),
  platform_digest: digest,
  selected_target: selectedTargetIdentitySchema,
  version: z.literal("spawnfile.target-local-container-bundle.prepare-request.v1"),
}).strict();

export type SpawnfileSelectedTarget = z.infer<typeof selectedTargetSchema>;
export type SpawnfileBundlePolicy = z.infer<typeof policySchema>;
export type SpawnfileBundlePreparationReceipt = z.infer<typeof bundleReceiptSchema>;
export type SpawnfileCredentialProvisioningReceipt = z.infer<typeof provisionReceiptSchema>;

const parseJson = (stdout: string, label: string): unknown => {
  try { return JSON.parse(stdout.trim()) as unknown; }
  catch { throw new TypeError(`Spawnfile ${label} did not emit JSON`); }
};
const canonicalTrustedJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonicalTrustedJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalTrustedJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
};
const temporaryJson = async <Value>(
  prefix: string,
  value: Value,
  work: (file: string) => Promise<unknown>,
  serialize: (input: Value) => string = canonicalComposedJson,
): Promise<unknown> => {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  try {
    const file = path.join(root, "request.json");
    await writeFile(file, serialize(value), { mode: 0o600 });
    return await work(file);
  } finally { await rm(root, { force: true, recursive: true }); }
};
const configBytes = (value: Uint8Array): Uint8Array => {
  if (value.byteLength < 1 || value.byteLength > 262_144) {
    throw new TypeError("Spawnfile target config is invalid");
  }
  return Uint8Array.from(value);
};

export const runSpawnfileCompile = async (context: SpawnfileCliContext, input: Readonly<{
  compiled_output_directory: string;
  organization_path: string;
  signal?: AbortSignal;
}>): Promise<unknown> => {
  await runSpawnfileProcess(context, { args: ["compile", input.organization_path,
    "--out", input.compiled_output_directory], signal: input.signal });
  return JSON.parse(await readFile(path.join(
    input.compiled_output_directory, "spawnfile-report.json",
  ), "utf8")) as unknown;
};

export const runSpawnfileSelectTarget = async (context: SpawnfileCliContext, input: Readonly<{
  request: unknown;
  signal?: AbortSignal;
  target_config_stdin: Uint8Array;
}>): Promise<SpawnfileSelectedTarget> => selectedTargetSchema.parse(await temporaryJson(
  "simfile-spawnfile-select-", input.request, async (file) => {
    const config = configBytes(input.target_config_stdin);
    try {
      const result = await runSpawnfileProcess(context, { args: ["target", "--config", "-",
        "select_target", file], signal: input.signal, stdin: config });
      return parseJson(result.stdout, "target selection");
    } finally { config.fill(0); }
  },
));

export const runSpawnfileDeriveBundlePolicy = async (
  context: SpawnfileCliContext,
  claims: unknown,
  signal?: AbortSignal,
): Promise<SpawnfileBundlePolicy> => policySchema.parse(await temporaryJson(
  "simfile-spawnfile-policy-", claims, async (file) => parseJson((
    await runSpawnfileProcess(context, { args: ["target", "--config", "-",
      "derive_container_bundle_policy", file], signal,
    stdin: new TextEncoder().encode("{}") })
  ).stdout, "bundle policy"),
));

const bundleDigest = (domain: "request" | "receipt", value: unknown): string =>
  `sha256:${createHash("sha256")
    .update(`spawnfile.target-local-container-bundle.${domain}.v1\0`)
    .update(canonicalTrustedJson(value)).digest("hex")}`;

export const runSpawnfilePrepareContainerBundle = async (
  context: SpawnfileCliContext,
  input: Readonly<{ request: Readonly<Record<string, unknown>>; signal?: AbortSignal;
    target_config_stdin: Uint8Array }>,
): Promise<SpawnfileBundlePreparationReceipt> => {
  const request = bundleRequestSchema.parse(input.request);
  const receipt = bundleReceiptSchema.parse(await temporaryJson(
    "simfile-spawnfile-bundle-", request, async (file) => {
      const config = configBytes(input.target_config_stdin);
      try {
        return parseJson((await runSpawnfileProcess(context, { args: ["target", "--config", "-",
          "prepare_container_bundle", file], signal: input.signal, stdin: config })).stdout,
        "bundle preparation");
      } finally { config.fill(0); }
    }, canonicalTrustedJson,
  ));
  const { receipt_digest: _receiptDigest, ...body } = receipt;
  if (receipt.request_digest !== bundleDigest("request", request)
    || receipt.receipt_digest !== bundleDigest("receipt", body)) {
    throw new TypeError("Spawnfile bundle preparation correlation is invalid");
  }
  return receipt;
};

export const runSpawnfileProvisionCredentials = async (
  context: SpawnfileCliContext,
  input: Readonly<{ env_file: string; request: unknown; resolved_grants_file: string;
    signal?: AbortSignal; world_bindings_file: string }>,
): Promise<SpawnfileCredentialProvisioningReceipt> => provisionReceiptSchema.parse(
  await temporaryJson("simfile-spawnfile-auth-", input.request, async (file) => parseJson((
    await runSpawnfileProcess(context, { args: ["auth", "provision", file,
      "--env-file", input.env_file, "--resolved-grants", input.resolved_grants_file,
      "--world-bindings", input.world_bindings_file], signal: input.signal })
  ).stdout, "credential provisioning")),
);

export const runSpawnfileRevokeCredentialSource = async (
  context: SpawnfileCliContext,
  input: Readonly<{ signal?: AbortSignal; source_handle: string }>,
): Promise<void> => {
  const failures: unknown[] = [];
  for (const operation of ["revoke-grant", "revoke-version"] as const) {
    try {
      await temporaryJson("simfile-spawnfile-revoke-", {
        source_handle: handle.parse(input.source_handle),
        version: "spawnfile.auth.target-secret.source-request.v1",
      }, async (file) => {
        const result = await runSpawnfileProcess(context, { args: ["auth", "target-secret",
          operation, file], signal: input.signal });
        const receipt = parseJson(result.stdout, "credential revocation") as Record<string, unknown>;
        if (receipt.kind !== operation || receipt.source_handle !== input.source_handle
          || receipt.version !== "spawnfile.auth.target-secret.receipt.v1") {
          throw new TypeError("Spawnfile credential revocation receipt is invalid");
        }
        return receipt;
      });
    } catch (error) { failures.push(error); }
  }
  if (failures.length > 0) throw new AggregateError(
    failures, "Spawnfile credential source revocation is incomplete",
  );
};
