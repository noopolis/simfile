import path from "node:path";

import { z } from "zod";

import { parseWorldSidecarReadiness } from "../world-artifact/readiness.js";
import {
  assertSecretFreeComposedJson,
  canonicalComposedJson,
  digestComposedJson,
} from "./json.js";
import { parseComposedPhaseJournal } from "./journal.js";
import { composedPhasePayload } from "./phase.js";
import { parseComposedTerminalReceipt } from "./receipt.js";
import { WORLD_DECISION_CLAIM_CAPABILITY } from "./request.js";
import type { ComposedReplayReceipt } from "./replay.js";
import { verifyComposedTerminalOutcome } from "./terminalOutcome.js";

export const COMPOSED_LIFECYCLE_REPLAY_SMOKE_MODE =
  "lifecycle-replay-smoke" as const;
export const COMPOSED_LIFECYCLE_REPLAY_SMOKE_RECEIPT_VERSION =
  "simfile.composed-lifecycle-replay-smoke-receipt.v1" as const;

const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const absolute = z.string().max(4_096).refine((value) => path.isAbsolute(value));
const replay = z.object({
  accepted_action_count: z.number().int().min(0),
  exact: z.literal(true),
  probe_sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  run_id: z.string().min(1),
  terminal_state_sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  terminal_tick: z.number().int().min(1),
  version: z.literal("simfile.composed-replay-receipt.v1"),
}).strict();
const moltnet = z.object({
  architecture: z.enum(["amd64", "arm64"]),
  asset: z.string().min(1),
  asset_sha256: digest,
  capabilities: z.tuple([z.literal("pi-bridge")]),
  release_version: z.string().min(1),
  source_revision: z.string().regex(/^[a-f0-9]{40}$/u),
  version: z.literal("spawnfile.moltnet-release-identity.v1"),
}).strict();
const viewer = z.discriminatedUnion("state", [
  z.object({ state: z.literal("disabled") }).strict(),
  z.object({
    state: z.literal("attached"),
    url: z.string().url().regex(/^http:\/\/127\.0\.0\.1:/u),
  }).strict(),
  z.object({
    error: z.string().min(1).max(4_096),
    state: z.literal("unavailable"),
  }).strict(),
]);

export const composedLifecycleReplaySmokeReceiptSchema = z.object({
  cleanup: z.object({
    receipt_digest: digest,
    remaining_owned_resources: z.array(z.string()).length(0),
    state: z.literal("cleaned"),
  }).strict(),
  evidence: z.record(z.string(), z.unknown()),
  exact_replay: replay,
  lifecycle_receipt_digest: digest,
  lifecycle_replay_verdict: z.literal("passed"),
  live_agent_evidence: z.object({
    state: z.literal("not_evaluated"),
  }).strict(),
  manifest_digest: digest,
  mode: z.literal(COMPOSED_LIFECYCLE_REPLAY_SMOKE_MODE),
  moltnet: moltnet.nullable(),
  receipt_digest: digest,
  run_id: z.string().min(1),
  run_path: absolute,
  status: z.literal("completed"),
  target: z.record(z.string(), z.unknown()),
  version: z.literal(COMPOSED_LIFECYCLE_REPLAY_SMOKE_RECEIPT_VERSION),
  viewer,
  world_claim: z.object({
    attested: z.literal(true),
    identity: z.literal(WORLD_DECISION_CLAIM_CAPABILITY),
    manifest_digest: digest,
  }).strict(),
}).strict();

export type ComposedLifecycleReplaySmokeReceipt = z.infer<
  typeof composedLifecycleReplaySmokeReceiptSchema
>;

export const parseComposedLifecycleReplaySmokeReceipt = (
  raw: unknown,
): ComposedLifecycleReplaySmokeReceipt => {
  assertSecretFreeComposedJson(raw);
  const value = composedLifecycleReplaySmokeReceiptSchema.parse(raw);
  const { receipt_digest: _receiptDigest, ...body } = value;
  if (value.receipt_digest !== digestComposedJson(
    COMPOSED_LIFECYCLE_REPLAY_SMOKE_RECEIPT_VERSION,
    body,
  )) {
    throw new TypeError("composed lifecycle/replay smoke receipt digest is invalid");
  }
  if (value.exact_replay.run_id !== value.run_id) {
    throw new TypeError("composed lifecycle/replay smoke correlation is invalid");
  }
  return Object.freeze(value);
};

export const createComposedLifecycleReplaySmokeReceipt = (input: Readonly<{
  journal: unknown;
  lifecycle_receipt: unknown;
  manifest_digest: string;
  replay: ComposedReplayReceipt;
  run_path: string;
  viewer: z.infer<typeof viewer>;
}>): ComposedLifecycleReplaySmokeReceipt => {
  const journal = parseComposedPhaseJournal(input.journal);
  const lifecycle = parseComposedTerminalReceipt(input.lifecycle_receipt);
  if (journal.request.mode !== "live"
    || journal.current_phase !== "completed"
    || lifecycle.run_id !== journal.request.run_id
    || input.replay.run_id !== journal.request.run_id
    || lifecycle.seal.state !== "sealed"
    || lifecycle.cleanup.state !== "cleaned"
    || lifecycle.verdict.state !== "valid") {
    throw new TypeError("composed lifecycle/replay smoke completion proof is invalid");
  }
  verifyComposedTerminalOutcome(journal, input.replay);
  const organization = composedPhasePayload(journal, "organization_ready");
  const readiness = parseWorldSidecarReadiness(
    composedPhasePayload(journal, "world_ready").readiness,
  );
  const claim = readiness.capabilities?.find(({ identity }) =>
    identity === WORLD_DECISION_CLAIM_CAPABILITY);
  if (claim === undefined
    || !readiness.capability_manifest_digests.includes(claim.manifest_digest)) {
    throw new TypeError("composed lifecycle/replay smoke claim is not attested");
  }
  const body = {
    cleanup: lifecycle.cleanup,
    evidence: lifecycle.evidence,
    exact_replay: input.replay,
    lifecycle_receipt_digest: lifecycle.receipt_digest,
    lifecycle_replay_verdict: "passed" as const,
    live_agent_evidence: { state: "not_evaluated" as const },
    manifest_digest: input.manifest_digest,
    mode: COMPOSED_LIFECYCLE_REPLAY_SMOKE_MODE,
    moltnet: moltnet.nullable().parse(organization.moltnet_release),
    run_id: lifecycle.run_id,
    run_path: path.resolve(input.run_path),
    status: "completed" as const,
    target: lifecycle.target,
    version: COMPOSED_LIFECYCLE_REPLAY_SMOKE_RECEIPT_VERSION,
    viewer: input.viewer,
    world_claim: {
      attested: true as const,
      identity: WORLD_DECISION_CLAIM_CAPABILITY,
      manifest_digest: claim.manifest_digest,
    },
  };
  return parseComposedLifecycleReplaySmokeReceipt({
    ...body,
    receipt_digest: digestComposedJson(
      COMPOSED_LIFECYCLE_REPLAY_SMOKE_RECEIPT_VERSION,
      body,
    ),
  });
};

export const serializeComposedLifecycleReplaySmokeReceipt = (
  receipt: ComposedLifecycleReplaySmokeReceipt,
): string => `${canonicalComposedJson(
  parseComposedLifecycleReplaySmokeReceipt(receipt),
)}\n`;

export const writeComposedLifecycleReplaySmokeReceipt = (
  receipt: ComposedLifecycleReplaySmokeReceipt,
): void => {
  process.stdout.write(serializeComposedLifecycleReplaySmokeReceipt(receipt));
};
