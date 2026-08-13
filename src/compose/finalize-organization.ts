import { z } from "zod";

import {
  composedDigestSchema,
  composedIdentifierSchema,
  composedRunIdSchema,
  parseComposedDigestedContract,
  sealComposedContract,
} from "./contracts.js";
import { assertSecretFreeComposedJson, digestComposedJson } from "./json.js";
import { parseComposedPhaseJournal, type ComposedPhaseJournal } from "./journal.js";
import {
  commitComposedPhase,
  composedPhaseReached,
  type ComposedPhaseContext,
} from "./phase.js";
import { composedRunPhaseIndex } from "./types.js";

export const COMPOSED_ORGANIZATION_EVIDENCE_VERSION =
  "simfile.composed-organization-evidence.v1" as const;
export const ORGANIZATION_EVIDENCE_RECOVERY_INSTRUCTION =
  "resume the persisted composed journal at organization_evidence_exported" as const;

const relativePath = z.string().max(512).regex(
  /^(?:[A-Za-z0-9][A-Za-z0-9._-]*\/)*[A-Za-z0-9][A-Za-z0-9._-]*$/u,
);
const rawFile = z.object({
  bytes: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  path: relativePath,
  sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  source: z.object({
    kind: z.enum(["container", "volume"]),
    ref: z.string().min(1).max(4_096),
  }).strict(),
}).strict();
const rawResult = z.object({
  deployment: composedIdentifierSchema,
  failed_files: z.array(relativePath).max(100_000),
  index: z.object({
    deployment: composedIdentifierSchema,
    exported_at: z.string().datetime({ offset: true }),
    files: z.array(rawFile).max(100_000),
    run_id: composedRunIdSchema,
    version: z.literal("spawnfile.export-index.v1"),
  }).strict(),
  index_path: z.string().min(1).max(4_096),
  missing_optional_files: z.array(relativePath).max(100_000),
}).passthrough();
const authority = z.enum(["spawnfile", "moltnet", "daimon", "mneme"]);
const evidenceFile = z.object({
  authority: authority.exclude(["spawnfile"]),
  bytes: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  path: relativePath,
  sha256: composedDigestSchema,
}).strict();
const authorityEntry = z.object({
  authority,
  digest: composedDigestSchema,
  item_count: z.number().int().min(0).max(100_000),
  missing_optional_count: z.number().int().min(0).max(100_000),
}).strict();
const evidenceSchema = z.object({
  authorities: z.tuple([authorityEntry, authorityEntry, authorityEntry, authorityEntry]),
  deployment: composedIdentifierSchema,
  export_index_digest: composedDigestSchema,
  files: z.array(evidenceFile).max(100_000),
  inventory_digest: composedDigestSchema,
  missing_optional_files: z.array(relativePath).max(100_000),
  organization_phase_digest: composedDigestSchema,
  receipt_digest: composedDigestSchema,
  run_id: composedRunIdSchema,
  source_state: z.literal("preserved"),
  state: z.literal("exported"),
  version: z.literal(COMPOSED_ORGANIZATION_EVIDENCE_VERSION),
}).strict().superRefine((value, context) => {
  const expected = ["spawnfile", "moltnet", "daimon", "mneme"] as const;
  const paths = value.files.map((item) => item.path);
  const missing = value.missing_optional_files;
  if (value.authorities.some((item, index) => item.authority !== expected[index])
    || new Set(paths).size !== paths.length
    || paths.some((item, index) => index > 0 && paths[index - 1]! >= item)
    || new Set(missing).size !== missing.length
    || missing.some((item, index) => index > 0 && missing[index - 1]! >= item)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "composed organization evidence inventory is invalid",
    });
  }
});

export type ComposedOrganizationEvidenceReceipt = z.infer<typeof evidenceSchema>;

export class ComposedOrganizationEvidenceError extends Error {
  readonly recovery_instruction = ORGANIZATION_EVIDENCE_RECOVERY_INSTRUCTION;
  readonly source_preserved = true;

  constructor() {
    super("composed organization evidence is recoverable");
    this.name = "ComposedOrganizationEvidenceError";
  }
}

const authorityFor = (value: string): "daimon" | "mneme" | "moltnet" => {
  const match = value.match(/^raw\/(daimon|mneme|moltnet)\//u)?.[1];
  if (match !== "daimon" && match !== "mneme" && match !== "moltnet") {
    throw new TypeError("Spawnfile export contains an unknown authority");
  }
  return match;
};

const inventoryBody = (receipt: ComposedOrganizationEvidenceReceipt) => ({
  files: receipt.files,
  missing_optional_files: receipt.missing_optional_files,
});

export const parseComposedOrganizationEvidenceReceipt = (
  raw: unknown,
): ComposedOrganizationEvidenceReceipt => {
  const receipt = parseComposedDigestedContract(raw, evidenceSchema,
    COMPOSED_ORGANIZATION_EVIDENCE_VERSION, "composed organization evidence receipt");
  if (receipt.inventory_digest !== digestComposedJson(
    "simfile.composed-organization-evidence-inventory.v1", inventoryBody(receipt),
  )) throw new TypeError("composed organization evidence inventory digest is invalid");
  for (const entry of receipt.authorities) {
    if (entry.authority === "spawnfile") {
      if (entry.digest !== receipt.export_index_digest
        || entry.item_count !== 1 || entry.missing_optional_count !== 0) {
        throw new TypeError("composed Spawnfile evidence authority is invalid");
      }
      continue;
    }
    const files = receipt.files.filter((item) => item.authority === entry.authority);
    const missing = receipt.missing_optional_files.filter(
      (item) => authorityFor(item) === entry.authority,
    );
    if ((entry.authority !== "mneme" && files.length + missing.length < 1)
      || entry.item_count !== files.length
      || entry.missing_optional_count !== missing.length
      || entry.digest !== digestComposedJson(
        `simfile.composed-organization-evidence-authority.${entry.authority}.v1`,
        { files, missing_optional_files: missing },
      )) throw new TypeError("composed organization evidence authority is invalid");
  }
  return receipt;
};

const createEvidenceReceipt = (input: Readonly<{
  deployment: string;
  organization_phase_digest: string;
  raw: unknown;
  run_id: string;
}>): ComposedOrganizationEvidenceReceipt => {
  assertSecretFreeComposedJson(input.raw);
  const result = rawResult.parse(input.raw);
  if (result.failed_files.length > 0
    || result.deployment !== input.deployment
    || result.index.deployment !== input.deployment
    || result.index.run_id !== input.run_id) {
    throw new TypeError("Spawnfile export correlation is invalid");
  }
  const rawPaths = result.index.files.map((item) => item.path);
  if (new Set(rawPaths).size !== rawPaths.length
    || rawPaths.some((item, index) => index > 0 && rawPaths[index - 1]! >= item)) {
    throw new TypeError("Spawnfile export index ordering is invalid");
  }
  const files = result.index.files.map((item) => ({
    authority: authorityFor(item.path),
    bytes: item.bytes,
    path: item.path,
    sha256: `sha256:${item.sha256}` as const,
  }));
  const missing = [...result.missing_optional_files].sort();
  missing.forEach(authorityFor);
  const exportIndexDigest = digestComposedJson("spawnfile.export-index.v1", result.index);
  const authorities = (["spawnfile", "moltnet", "daimon", "mneme"] as const).map((name) => {
    if (name === "spawnfile") return {
      authority: name, digest: exportIndexDigest, item_count: 1, missing_optional_count: 0,
    };
    const items = files.filter((item) => item.authority === name);
    const absent = missing.filter((item) => authorityFor(item) === name);
    return {
      authority: name,
      digest: digestComposedJson(
        `simfile.composed-organization-evidence-authority.${name}.v1`,
        { files: items, missing_optional_files: absent },
      ),
      item_count: items.length,
      missing_optional_count: absent.length,
    };
  }) as ComposedOrganizationEvidenceReceipt["authorities"];
  const inventory = { files, missing_optional_files: missing };
  return parseComposedOrganizationEvidenceReceipt(sealComposedContract(
    COMPOSED_ORGANIZATION_EVIDENCE_VERSION,
    {
      authorities,
      deployment: input.deployment,
      export_index_digest: exportIndexDigest,
      ...inventory,
      inventory_digest: digestComposedJson(
        "simfile.composed-organization-evidence-inventory.v1", inventory,
      ),
      organization_phase_digest: input.organization_phase_digest,
      run_id: input.run_id,
      source_state: "preserved",
      state: "exported",
      version: COMPOSED_ORGANIZATION_EVIDENCE_VERSION,
    },
  ));
};

export interface ComposedOrganizationFinalizationPort {
  exportOrganizationEvidence(input: Readonly<{
    deployment_name: string;
    lifecycle_invocation_id: string;
    organization_phase_digest: string;
    run_id: string;
    signal: AbortSignal;
  }>): Promise<unknown>;
}

export const composedOrganizationExportLifecycleInvocationId = (
  requestDigest: string,
): string =>
  `lci_${digestComposedJson("simfile.composed-organization-export-operation.v1", {
    operation: "artifacts_export", request_digest: composedDigestSchema.parse(requestDigest),
  }).slice(7, 39)}`;

/** Exports public Spawnfile evidence only after the world evidence is durable. */
export const finalizeComposedOrganization = async (input: Readonly<{
  context: ComposedPhaseContext;
  deployment_name: string;
  journal: unknown;
  port: ComposedOrganizationFinalizationPort;
  signal?: AbortSignal;
}>): Promise<ComposedPhaseJournal> => {
  let journal = parseComposedPhaseJournal(input.journal);
  if (!composedPhaseReached(journal, "world_evidence_exported")) {
    throw new TypeError("composed organization finalization requires world evidence");
  }
  if (composedPhaseReached(journal, "organization_evidence_exported")) return journal;
  const organizationPhaseDigest = journal.entries[
    composedRunPhaseIndex("organization_ready")
  ]!.payload_digest;
  let evidence: ComposedOrganizationEvidenceReceipt;
  try {
    evidence = createEvidenceReceipt({
      deployment: input.deployment_name,
      organization_phase_digest: organizationPhaseDigest,
      raw: await input.port.exportOrganizationEvidence({
        deployment_name: input.deployment_name,
        lifecycle_invocation_id: composedOrganizationExportLifecycleInvocationId(
          journal.request_digest,
        ),
        organization_phase_digest: organizationPhaseDigest,
        run_id: journal.request.run_id,
        signal: input.signal ?? new AbortController().signal,
      }),
      run_id: journal.request.run_id,
    });
  } catch {
    throw new ComposedOrganizationEvidenceError();
  }
  journal = await commitComposedPhase(journal, "organization_evidence_exported", {
    evidence, receipt_digest: evidence.receipt_digest, run_id: journal.request.run_id,
  }, input.context);
  return journal;
};
