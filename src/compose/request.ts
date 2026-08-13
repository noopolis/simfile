import { z } from "zod";

import { assertSecretFreeComposedJson, digestComposedJson } from "./json.js";

export const COMPOSED_RUN_REQUEST_VERSION = "simfile.composed-run-request.v1" as const;
export const WORLD_DECISION_CLAIM_CAPABILITY = "simfile.world-decision-claim.v1" as const;

const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const identifier = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/u);
const runId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u);
const capability = z.string().regex(/^[a-z][a-z0-9.-]{0,127}\.v[1-9][0-9]*$/u);

export const composedRunRequestSchema = z.object({
  descriptor_digest: digest,
  mode: z.enum(["dry-run", "live"]),
  organization: z.object({
    artifact_digest: digest,
    source_digest: digest,
    world_bindings_digest: digest,
  }).strict(),
  required_world_capabilities: z.array(capability).max(32),
  run_id: runId,
  source_digest: digest,
  target: z.object({
    auth_profile: identifier,
    selector: identifier,
  }).strict(),
  version: z.literal(COMPOSED_RUN_REQUEST_VERSION),
  world: z.object({
    artifact_manifest_digest: digest,
    bundle_digest: digest,
    runtime_abi: z.literal("simfile.world-sidecar-runtime.v1"),
  }).strict(),
}).strict().superRefine((value, context) => {
  const capabilities = value.required_world_capabilities;
  if (new Set(capabilities).size !== capabilities.length
    || capabilities.some((item, index) => index > 0 && capabilities[index - 1]! >= item)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "world capabilities must be sorted and unique" });
  }
  if (value.mode === "live" && !capabilities.includes(WORLD_DECISION_CLAIM_CAPABILITY)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "live mode requires decision-claim capability" });
  }
});

export type ComposedRunRequest = z.infer<typeof composedRunRequestSchema>;

export const parseComposedRunRequest = (raw: unknown): ComposedRunRequest => {
  assertSecretFreeComposedJson(raw);
  return Object.freeze(composedRunRequestSchema.parse(raw));
};

export const createComposedRunRequestDigest = (raw: unknown): `sha256:${string}` =>
  digestComposedJson(COMPOSED_RUN_REQUEST_VERSION, parseComposedRunRequest(raw));
