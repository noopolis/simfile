import { Buffer } from "node:buffer";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { z } from "zod";

import { canonicalComposedJson, digestComposedJson } from "../compose/json.js";
import { runSpawnfileProcess, type BootstrapSpawnfileCliContext } from "./process.js";

const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const handle = z.string().regex(/^opaque_[a-z0-9]{16,64}$/u);
const selected = z.object({
  fingerprint: z.string().regex(/^sha256:[a-f0-9]{32}$/u), handle,
}).strict();
const platform = z.object({ architecture: z.enum(["amd64", "arm64"]),
  os: z.literal("linux") }).strict();
const requestSchema = z.object({
  archive_base64: z.string().max(5_592_408).refine((value) => {
    const bytes = Buffer.from(value, "base64");
    return value.length % 4 === 0 && bytes.byteLength <= 4_194_304
      && bytes.toString("base64") === value;
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
  platform,
  platform_digest: digest,
  selected_target: selected,
  version: z.literal("spawnfile.target-local-container-bundle.prepare-request.v1"),
}).strict();
const receiptSchema = z.object({
  archive_digest: digest, artifact_digest: digest, build_policy_digest: digest,
  bundle_digest: digest, launcher_digest: digest, mapping_handle: handle,
  network_alias: z.string(), operation_handle: handle, platform,
  platform_digest: digest, receipt_digest: digest, request_digest: digest,
  selected_target: selected,
  version: z.literal("spawnfile.target-local-container-bundle.prepare-receipt.v1"),
}).strict();
const lookupSchema = z.discriminatedUnion("status", [
  z.object({ idempotency_key: z.string(), request_digest: digest,
    status: z.literal("not_applied"),
    version: z.literal("spawnfile.target-local-container-bundle.lookup.v1") }).strict(),
  z.object({ idempotency_key: z.string(), operation_handle: handle,
    request_digest: digest, status: z.literal("pending"),
    version: z.literal("spawnfile.target-local-container-bundle.lookup.v1") }).strict(),
  z.object({ idempotency_key: z.string(), operation_handle: handle,
    receipt: receiptSchema, request_digest: digest, status: z.literal("completed"),
    version: z.literal("spawnfile.target-local-container-bundle.lookup.v1") }).strict(),
]);
const policySchema = z.object({ build_policy_digest: digest, platform_digest: digest,
  version: z.literal("spawnfile.target-local-container-bundle-policy.v1") }).strict();

export type SpawnfileBundleRequest = z.infer<typeof requestSchema>;
export type SpawnfileBundleReceipt = z.infer<typeof receiptSchema>;
export type SpawnfileBundleLookup = z.infer<typeof lookupSchema>;
export const parseSpawnfileBundleReceipt = (raw: unknown): SpawnfileBundleReceipt => {
  const receipt = receiptSchema.parse(raw);
  const { receipt_digest: _receipt, ...body } = receipt;
  if (receipt.receipt_digest !== digestComposedJson(
    "spawnfile.target-local-container-bundle.receipt.v1", body,
  )) throw new TypeError("Spawnfile container bundle receipt digest is invalid");
  return Object.freeze(receipt);
};

const temporary = async (prefix: string, value: unknown,
  work: (file: string) => Promise<string>): Promise<string> => {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  try {
    const file = path.join(root, "request.json");
    await writeFile(file, canonicalComposedJson(value), { mode: 0o600 });
    return await work(file);
  } finally { await rm(root, { force: true, recursive: true }); }
};
const parseJson = (value: string): unknown => {
  try { return JSON.parse(value.trim()) as unknown; }
  catch { throw new TypeError("Spawnfile container bundle command did not emit JSON"); }
};
const configCopy = (value: Uint8Array): Uint8Array => {
  if (value.byteLength < 1 || value.byteLength > 262_144) {
    throw new TypeError("Spawnfile target configuration is invalid");
  }
  return Uint8Array.from(value);
};

export const spawnfileBundleRequestDigest = (raw: unknown): `sha256:${string}` =>
  digestComposedJson("spawnfile.target-local-container-bundle.request.v1",
    requestSchema.parse(raw));

export const runSpawnfileDeriveBundlePolicy = async (
  context: BootstrapSpawnfileCliContext, claims: unknown, signal?: AbortSignal,
) => policySchema.parse(parseJson(await temporary("simfile-bundle-policy-", claims,
  async (file) => (await runSpawnfileProcess(context, {
    args: ["target", "--config", "-", "derive_container_bundle_policy", file],
    signal, stdin: new TextEncoder().encode("{}"),
  })).stdout)));

export const runSpawnfileContainerBundle = async (input: Readonly<{
  command: "prepare_container_bundle" | "recover_container_bundle";
  context: BootstrapSpawnfileCliContext;
  request: unknown;
  signal?: AbortSignal;
  target_config: Uint8Array;
}>): Promise<SpawnfileBundleReceipt> => {
  const request = requestSchema.parse(input.request);
  const config = configCopy(input.target_config);
  try {
    const raw = parseJson(await temporary("simfile-bundle-", request,
      async (file) => (await runSpawnfileProcess(input.context, {
        args: ["target", "--config", "-", input.command, file],
        signal: input.signal, stdin: config,
      })).stdout));
    const receipt = parseSpawnfileBundleReceipt(raw);
    if (receipt.request_digest !== spawnfileBundleRequestDigest(request)
    ) throw new TypeError("Spawnfile container bundle correlation is invalid");
    return Object.freeze(receipt);
  } finally { config.fill(0); }
};

export const runSpawnfileContainerBundleLookup = async (input: Readonly<{
  context: BootstrapSpawnfileCliContext;
  idempotency_key: string;
  request_digest: string;
  signal?: AbortSignal;
  target_config: Uint8Array;
}>): Promise<SpawnfileBundleLookup> => {
  const lookup = { idempotency_key: input.idempotency_key,
    request_digest: input.request_digest,
    version: "spawnfile.target-local-container-bundle.lookup.v1" };
  const config = configCopy(input.target_config);
  try {
    const result = lookupSchema.parse(parseJson(await temporary(
      "simfile-bundle-lookup-", lookup, async (file) => (await runSpawnfileProcess(
        input.context, { args: ["target", "--config", "-", "lookup_container_bundle", file],
          signal: input.signal, stdin: config },
      )).stdout,
    )));
    if (result.request_digest !== input.request_digest) {
      throw new TypeError("Spawnfile container bundle lookup correlation is invalid");
    }
    return Object.freeze(result);
  } finally { config.fill(0); }
};
