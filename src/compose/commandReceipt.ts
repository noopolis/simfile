import path from "node:path";

import { z } from "zod";

import { parseWorldSidecarReadiness } from "../world-artifact/readiness.js";
import { assertSecretFreeComposedJson, canonicalComposedJson, digestComposedJson } from "./json.js";
import { parseComposedPhaseJournal } from "./journal.js";
import { composedPhasePayload } from "./phase.js";
import { parseComposedTerminalReceipt } from "./receipt.js";
import { WORLD_DECISION_CLAIM_CAPABILITY } from "./request.js";
import type { ComposedLiveEvidenceVerdict } from "./liveEvidence.js";

export const COMPOSED_COMMAND_RECEIPT_VERSION = "simfile.composed-command-receipt.v1" as const;
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const absolute = z.string().max(4_096).refine((value) => path.isAbsolute(value));
const count = z.object({ count: z.number().int().min(0), participant: z.string().min(1),
  principal: z.string().min(1) }).strict();
const moltnet = z.object({
  architecture: z.enum(["amd64", "arm64"]), asset: z.string().min(1), asset_sha256: digest,
  capabilities: z.tuple([z.literal("pi-bridge")]), release_version: z.string().min(1),
  source_revision: z.string().regex(/^[a-f0-9]{40}$/u),
  version: z.literal("spawnfile.moltnet-release-identity.v1"),
}).strict();
const viewer = z.discriminatedUnion("state", [
  z.object({ state: z.literal("disabled") }).strict(),
  z.object({ state: z.literal("attached"), url: z.string().url().regex(/^http:\/\/127\.0\.0\.1:/u) }).strict(),
  z.object({ state: z.literal("unavailable"), error: z.string().min(1).max(4_096) }).strict(),
]);
export const composedCommandReceiptSchema = z.object({
  accepted_strategic_actions: z.array(count).min(1).max(4_096),
  cleanup: z.object({ receipt_digest: digest, remaining_owned_resources: z.array(z.string()),
    state: z.literal("cleaned") }).strict(),
  evidence: z.record(z.string(), z.unknown()),
  lifecycle_receipt_digest: digest,
  live_agent_evidence: z.object({ state: z.enum(["passed", "failed"]),
    zero_action_principals: z.array(z.string()) }).strict(),
  manifest_digest: digest,
  moltnet,
  receipt_digest: digest,
  run_id: z.string().min(1),
  run_path: absolute,
  simulation_verdict: z.literal("valid"),
  status: z.literal("completed"),
  target: z.record(z.string(), z.unknown()),
  version: z.literal(COMPOSED_COMMAND_RECEIPT_VERSION),
  viewer,
  world_claim: z.object({ attested: z.literal(true), identity: z.literal(WORLD_DECISION_CLAIM_CAPABILITY),
    manifest_digest: digest }).strict(),
}).strict();
export type ComposedCommandReceipt = z.infer<typeof composedCommandReceiptSchema>;

export const parseComposedCommandReceipt = (raw: unknown): ComposedCommandReceipt => {
  assertSecretFreeComposedJson(raw);
  const value = composedCommandReceiptSchema.parse(raw);
  const { receipt_digest: _receiptDigest, ...body } = value;
  if (value.receipt_digest !== digestComposedJson(COMPOSED_COMMAND_RECEIPT_VERSION, body)) {
    throw new TypeError("composed command receipt digest is invalid");
  }
  const zero = value.accepted_strategic_actions.filter(({ count: valueCount }) => valueCount === 0)
    .map(({ principal }) => principal);
  if (JSON.stringify(zero) !== JSON.stringify(value.live_agent_evidence.zero_action_principals)
    || (zero.length === 0) !== (value.live_agent_evidence.state === "passed")) {
    throw new TypeError("composed command live-agent verdict is invalid");
  }
  return Object.freeze(value);
};

/** Builds stdout truth only from the completed lifecycle, sealed record, and post-hoc counts. */
export const createComposedCommandReceipt = (input: Readonly<{
  journal: unknown;
  lifecycle_receipt: unknown;
  live_evidence: ComposedLiveEvidenceVerdict;
  manifest_digest: string;
  run_path: string;
  viewer: z.infer<typeof viewer>;
}>): ComposedCommandReceipt => {
  const journal = parseComposedPhaseJournal(input.journal);
  const lifecycle = parseComposedTerminalReceipt(input.lifecycle_receipt);
  if (journal.current_phase !== "completed" || lifecycle.run_id !== journal.request.run_id
    || lifecycle.seal.state !== "sealed" || lifecycle.cleanup.state !== "cleaned"
    || lifecycle.verdict.state !== "valid") {
    throw new TypeError("composed command completion proof is invalid");
  }
  const organization = composedPhasePayload(journal, "organization_ready");
  const readiness = parseWorldSidecarReadiness(composedPhasePayload(journal, "world_ready").readiness);
  const claim = readiness.capabilities?.find(({ identity }) =>
    identity === WORLD_DECISION_CLAIM_CAPABILITY);
  if (claim === undefined || !readiness.capability_manifest_digests.includes(claim.manifest_digest)) {
    throw new TypeError("composed command claim capability is not attested");
  }
  const body = {
    accepted_strategic_actions: input.live_evidence.counts,
    cleanup: lifecycle.cleanup,
    evidence: lifecycle.evidence,
    lifecycle_receipt_digest: lifecycle.receipt_digest,
    live_agent_evidence: { state: input.live_evidence.state,
      zero_action_principals: input.live_evidence.zero_action_principals },
    manifest_digest: input.manifest_digest,
    moltnet: moltnet.parse(organization.moltnet_release),
    run_id: lifecycle.run_id,
    run_path: path.resolve(input.run_path),
    simulation_verdict: "valid" as const,
    status: "completed" as const,
    target: lifecycle.target,
    version: COMPOSED_COMMAND_RECEIPT_VERSION,
    viewer: input.viewer,
    world_claim: { attested: true as const, identity: WORLD_DECISION_CLAIM_CAPABILITY,
      manifest_digest: claim.manifest_digest },
  };
  return parseComposedCommandReceipt({ ...body,
    receipt_digest: digestComposedJson(COMPOSED_COMMAND_RECEIPT_VERSION, body) });
};

export const serializeComposedCommandReceipt = (receipt: ComposedCommandReceipt): string =>
  `${canonicalComposedJson(parseComposedCommandReceipt(receipt))}\n`;
export const composedCommandExitCode = (receipt: ComposedCommandReceipt): 0 | 1 =>
  parseComposedCommandReceipt(receipt).live_agent_evidence.state === "passed" ? 0 : 1;
export const writeComposedProgress = (message: string): void => {
  process.stderr.write(`${message}\n`);
};
export const writeComposedFinalReceipt = (receipt: ComposedCommandReceipt): void => {
  process.stdout.write(serializeComposedCommandReceipt(receipt));
};

