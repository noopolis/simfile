import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { z } from "zod";

import { canonicalComposedJson } from "../compose/json.js";
import { runSpawnfileProcess, type BootstrapSpawnfileCliContext } from "./process.js";

const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const handle = z.string().regex(/^opaque_[a-z0-9]{16,64}$/u);
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
export type SpawnfileCredentialProvisioningReceipt = z.infer<typeof provisionReceiptSchema>;
export const parseSpawnfileCredentialProvisioningReceipt = (
  raw: unknown,
): SpawnfileCredentialProvisioningReceipt => Object.freeze(provisionReceiptSchema.parse(raw));

const parseJson = (stdout: string, label: string): unknown => {
  try { return JSON.parse(stdout.trim()) as unknown; }
  catch { throw new TypeError(`Spawnfile ${label} did not emit JSON`); }
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

export const runSpawnfileCompile = async (context: BootstrapSpawnfileCliContext, input: Readonly<{
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

export const runSpawnfileProvisionCredentials = async (
  context: BootstrapSpawnfileCliContext,
  input: Readonly<{ env_file: string; request: unknown; resolved_grants_file: string;
    signal?: AbortSignal; world_bindings_file: string }>,
): Promise<SpawnfileCredentialProvisioningReceipt> => parseSpawnfileCredentialProvisioningReceipt(
  await temporaryJson("simfile-spawnfile-auth-", input.request, async (file) => parseJson((
    await runSpawnfileProcess(context, { args: ["auth", "provision", file,
      "--env-file", input.env_file, "--resolved-grants", input.resolved_grants_file,
      "--world-bindings", input.world_bindings_file], signal: input.signal })
  ).stdout, "credential provisioning")),
);

export const runSpawnfileRevokeCredentialSource = async (
  context: BootstrapSpawnfileCliContext,
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
