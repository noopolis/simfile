import { createHash } from "node:crypto";

import { z } from "zod";
import { targetResourceReceiptSchema } from "../spawnfile/targetReceipts.js";

import { assertSecretFreeComposedJson, digestComposedJson } from "./json.js";
import { parseComposedPhaseJournal, type ComposedPhaseJournal } from "./journal.js";
import {
  commitComposedPhase,
  composedPhasePayload,
  composedPhaseReached,
  type ComposedPhaseContext,
} from "./phase.js";

const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const runId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u);
const opaque = z.string().regex(/^opaque_[a-z0-9]{16,64}$/u);
const readiness = z.object({
  code: z.literal("organization_ready"),
  compile_fingerprint: z.string().regex(/^sf1:[a-f0-9]{12}$/u),
  run_id: runId,
  state: z.literal("ready"),
  unit_id: runId,
  version: z.literal("spawnfile.organization-ready.v1"),
  world_binding_digest: digest,
}).strict();
const release = z.object({
  architecture: z.enum(["amd64", "arm64"]),
  asset: z.string().regex(/^moltnet_linux_(?:amd64|arm64)\.tar\.gz$/u),
  asset_sha256: digest,
  capabilities: z.tuple([z.literal("pi-bridge")]),
  release_version: z.string().regex(/^v?\d+\.\d+\.\d+(?:-\d+-g[a-f0-9]{7,40})?$/u),
  source_revision: z.string().regex(/^[a-f0-9]{40}$/u),
  version: z.literal("spawnfile.moltnet-release-identity.v1"),
}).strict().superRefine((value, context) => {
  if (value.asset !== `moltnet_linux_${value.architecture}.tar.gz`) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Moltnet asset architecture is invalid",
      path: ["asset"],
    });
  }
  const describedRevision = value.release_version.match(/-g([a-f0-9]{7,40})$/u)?.[1];
  if (describedRevision && !value.source_revision.startsWith(describedRevision)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Moltnet release version does not describe its source revision",
      path: ["source_revision"],
    });
  }
});
const handoff = z.object({
  binding_digest: digest,
  deployment_handle: z.string().regex(/^sf-oh1-[a-f0-9]{64}$/u),
  lifecycle_receipts: z.object({
    down: z.literal("spawnfile.down-receipt.v1"),
    export: z.literal("spawnfile.export-index.v1"),
    up: z.literal("spawnfile.up-receipt.v1"),
  }).strict(),
  network_attachment_handle: opaque,
  run_id: runId,
  selected_target_receipt_digest: digest,
  version: z.literal("spawnfile.organization-handoff.v1"),
}).strict();
const upReceipt = z.object({
  compiled_schedule: z.array(z.object({ agent: runId, cron: z.string().min(1) }).passthrough()),
  deployment: z.object({
    container_ids: z.array(runId).min(1),
    name: runId,
  }).passthrough(),
  engines: z.array(z.object({ agent: runId, engine: runId }).passthrough()).min(1),
  fingerprint: z.string().regex(/^sf1:[a-f0-9]{12}$/u),
  moltnet_release: release,
  organization_handoff: handoff,
  organization_handoff_handle: opaque,
  organization_ready: readiness.optional(),
  readiness: z.object({
    moltnet_base_url: z.string().url(),
    state: z.literal("running"),
  }).passthrough(),
  run_id: runId,
  target_attachment: targetResourceReceiptSchema.optional(),
  version: z.literal("spawnfile.up-receipt.v1"),
}).passthrough();

export type ComposedOrganizationUpReceipt = z.infer<typeof upReceipt>;

export interface ComposedOrganizationExpectation {
  readonly deployment_name: string;
  readonly member_engines: Readonly<Record<string, string>>;
  readonly moltnet_release: Readonly<{
    architecture: "amd64" | "arm64";
    asset_sha256: string;
    release_version: string;
    source_revision: string;
  }>;
  readonly selected_target_receipt_digest: string;
  readonly unit_id: string;
  readonly world_binding_digest: string;
}

export interface ComposedOrganizationStartupPort {
  startOrganization(input: Readonly<{
    idempotency_key: string;
    run_id: string;
    signal: AbortSignal;
    world_readiness_digest: string;
  }>): Promise<unknown>;
  readOrganizationReadiness(input: Readonly<{
    up_receipt: ComposedOrganizationUpReceipt;
    signal: AbortSignal;
  }>): Promise<unknown>;
}

export const deriveComposedOrganizationDeploymentHandle = (
  value: Omit<z.infer<typeof handoff>, "deployment_handle" | "version">,
): string => {
  const canonical = [
    "spawnfile.organization-handoff.v1\0",
    value.run_id,
    value.selected_target_receipt_digest,
    value.network_attachment_handle,
    value.binding_digest,
    value.lifecycle_receipts.up,
    value.lifecycle_receipts.export,
    value.lifecycle_receipts.down,
  ].join("\n");
  return `sf-oh1-${createHash("sha256").update(canonical, "utf8").digest("hex")}`;
};

const noCognitionCriterion = (value: unknown): void => {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const [key, nested] of Object.entries(value)) {
      if (/(?:agent|participant).*(?:reply|response|turn|action)|(?:reply|response).*count/iu.test(key)) {
        throw new TypeError("organization readiness contains an agent-response criterion");
      }
      noCognitionCriterion(nested);
    }
  } else if (Array.isArray(value)) value.forEach(noCognitionCriterion);
};

export const verifyComposedOrganizationUpReceipt = (input: Readonly<{
  expectation: ComposedOrganizationExpectation;
  raw: unknown;
  require_ready: boolean;
  run_id: string;
}>): ComposedOrganizationUpReceipt => {
  assertSecretFreeComposedJson(input.raw);
  noCognitionCriterion(input.raw);
  const receipt = upReceipt.parse(input.raw);
  const expectedEngines = Object.entries(input.expectation.member_engines)
    .sort(([left], [right]) => left.localeCompare(right));
  const actualEngines = receipt.engines.map(({ agent, engine }) => [agent, engine] as const)
    .sort(([left], [right]) => left.localeCompare(right));
  const releaseExpected = input.expectation.moltnet_release;
  const { deployment_handle: _deploymentHandle, version: _handoffVersion, ...handoffBody }
    = receipt.organization_handoff;
  if (receipt.run_id !== input.run_id
    || receipt.deployment.name !== input.expectation.deployment_name
    || new Set(receipt.deployment.container_ids).size !== receipt.deployment.container_ids.length
    || JSON.stringify(actualEngines) !== JSON.stringify(expectedEngines)
    || receipt.moltnet_release.architecture !== releaseExpected.architecture
    || receipt.moltnet_release.asset !== `moltnet_linux_${releaseExpected.architecture}.tar.gz`
    || receipt.moltnet_release.asset_sha256 !== releaseExpected.asset_sha256
    || receipt.moltnet_release.release_version !== releaseExpected.release_version
    || receipt.moltnet_release.source_revision !== releaseExpected.source_revision
    || receipt.organization_handoff.run_id !== input.run_id
    || receipt.organization_handoff.binding_digest !== input.expectation.world_binding_digest
    || receipt.organization_handoff.selected_target_receipt_digest
      !== input.expectation.selected_target_receipt_digest
    || receipt.organization_handoff.deployment_handle
      !== deriveComposedOrganizationDeploymentHandle(handoffBody)) {
    throw new TypeError("composed organization receipt correlation is invalid");
  }
  if (input.require_ready && (!receipt.organization_ready
    || receipt.organization_ready.run_id !== input.run_id
    || receipt.organization_ready.world_binding_digest !== input.expectation.world_binding_digest
    || receipt.organization_ready.compile_fingerprint !== receipt.fingerprint
    || receipt.organization_ready.unit_id !== input.expectation.unit_id)) {
    throw new TypeError("composed organization readiness is invalid");
  }
  return Object.freeze(receipt);
};

const operationKey = (journal: ComposedPhaseJournal, operation: string): string =>
  `idem_${digestComposedJson("simfile.composed-organization-operation.v1", {
    operation, request_digest: journal.request_digest,
  }).slice(7, 39)}`;

/** Starts the organization only after world-only readiness, then proves exact bindings. */
export const startComposedOrganization = async (input: Readonly<{
  context: ComposedPhaseContext;
  expectation: ComposedOrganizationExpectation;
  journal: unknown;
  port: ComposedOrganizationStartupPort;
  signal?: AbortSignal;
}>): Promise<ComposedPhaseJournal> => {
  let journal = parseComposedPhaseJournal(input.journal);
  if (!composedPhaseReached(journal, "world_ready")) {
    throw new TypeError("composed organization startup requires world readiness");
  }
  const worldReadinessDigest = composedPhasePayload(journal, "world_ready").readiness_digest;
  if (typeof worldReadinessDigest !== "string") {
    throw new TypeError("composed world readiness digest is unavailable");
  }
  if (!composedPhaseReached(journal, "organization_started")) {
    const upReceiptValue = verifyComposedOrganizationUpReceipt({
      expectation: input.expectation,
      raw: await input.port.startOrganization({
        idempotency_key: operationKey(journal, "start_organization"),
        run_id: journal.request.run_id,
        signal: input.signal ?? new AbortController().signal,
        world_readiness_digest: worldReadinessDigest,
      }),
      require_ready: false,
      run_id: journal.request.run_id,
    });
    journal = await commitComposedPhase(journal, "organization_started", {
      run_id: journal.request.run_id,
      up_receipt: upReceiptValue,
      up_receipt_digest: digestComposedJson("spawnfile.up-receipt.v1", upReceiptValue),
    }, input.context);
  }
  if (!composedPhaseReached(journal, "organization_ready")) {
    const started = verifyComposedOrganizationUpReceipt({
      expectation: input.expectation,
      raw: composedPhasePayload(journal, "organization_started").up_receipt,
      require_ready: false,
      run_id: journal.request.run_id,
    });
    const ready = verifyComposedOrganizationUpReceipt({
      expectation: input.expectation,
      raw: await input.port.readOrganizationReadiness({
        signal: input.signal ?? new AbortController().signal,
        up_receipt: started,
      }),
      require_ready: true,
      run_id: journal.request.run_id,
    });
    journal = await commitComposedPhase(journal, "organization_ready", {
      moltnet_release: ready.moltnet_release,
      organization_handoff: ready.organization_handoff,
      readiness: ready.organization_ready,
      receipt_digest: digestComposedJson("spawnfile.up-receipt.v1", ready),
      run_id: journal.request.run_id,
    }, input.context);
  }
  return journal;
};
