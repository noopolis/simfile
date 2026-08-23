import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";

import { z } from "zod";

import { assertSecretFreeComposedJson, digestComposedJson } from "../compose/json.js";

const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const runId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u);
const publicArtifact = z.object({ artifact_id: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/u),
  content_base64: z.string().max(Math.ceil(131_072 / 3) * 4), content_digest: digest,
  media_type: z.string().min(1).max(127), request_digest: digest, run_id: runId,
  size_bytes: z.number().int().min(0).max(131_072),
  version: z.literal("spawnfile.target-public-artifact-snapshot.v1") }).strict();
const notPresent = z.object({ artifact_id: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/u),
  request_digest: digest, run_id: runId, status: z.literal("not_present"),
  version: z.literal("spawnfile.target-public-artifact-snapshot.not-present.v1") }).strict();

interface ReadInput { artifact_id: string; raw: unknown;
  request: Readonly<Record<string, unknown>> }

export const isTargetPublicArtifactNotPresent = (input: Readonly<ReadInput>): boolean => {
  assertSecretFreeComposedJson(input.raw);
  const receipt = notPresent.safeParse(input.raw);
  if (!receipt.success) return false;
  const artifact = input.request.artifact as Readonly<{ id?: unknown }> | undefined;
  return receipt.data.artifact_id === input.artifact_id
    && receipt.data.artifact_id === artifact?.id
    && receipt.data.run_id === input.request.run_id
    && receipt.data.request_digest === digestComposedJson(
      "spawnfile.target-public-artifact-snapshot.request.v1", input.request,
    );
};

export const readTargetPublicBytes = (input: Readonly<ReadInput>): Buffer => {
  assertSecretFreeComposedJson(input.raw);
  const receipt = publicArtifact.parse(input.raw);
  const bytes = Buffer.from(receipt.content_base64, "base64");
  try {
    const artifact = input.request.artifact as Readonly<{
      id?: unknown; max_bytes?: unknown; media_type?: unknown;
    }> | undefined;
    if (bytes.toString("base64") !== receipt.content_base64
      || bytes.byteLength !== receipt.size_bytes || receipt.artifact_id !== input.artifact_id
      || receipt.artifact_id !== artifact?.id || receipt.run_id !== input.request.run_id
      || receipt.media_type !== artifact?.media_type || !Number.isSafeInteger(artifact?.max_bytes)
      || receipt.size_bytes > (artifact?.max_bytes as number)
      || receipt.content_digest !== `sha256:${createHash("sha256").update(bytes).digest("hex")}`
      || receipt.request_digest !== digestComposedJson(
        "spawnfile.target-public-artifact-snapshot.request.v1", input.request,
      )) throw new TypeError("Spawnfile public artifact correlation is invalid");
    return bytes;
  } catch (error) { bytes.fill(0); throw error; }
};

export const readTargetPublicJson = (input: Readonly<ReadInput>): unknown => {
  const bytes = readTargetPublicBytes(input);
  try { return JSON.parse(bytes.toString("utf8")) as unknown; }
  finally { bytes.fill(0); }
};
