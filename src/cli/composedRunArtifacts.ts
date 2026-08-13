import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  canonicalComposedJson,
} from "../compose/json.js";
import {
  composedPhasePayload,
  createComposedRunRecord,
  parseComposedOrganizationEvidenceReceipt,
  parseComposedWorldEvidenceReceipt,
  type CompletedComposedRun,
  type ComposedRunRecord,
} from "../compose/index.js";
import {
  bindProjectViewerExtensions,
  loadProjectViewerExtensions,
} from "../viewer-extension/projectDeclaration.js";
import type { LinkedComposedBootstrap } from "./composedRunBootstrap.js";
import { linkedComposedViewerManifestFields } from "./composedViewerBinding.js";

const sha = (bytes: Uint8Array): string =>
  `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const correlatedBytes = async (
  root: string,
  source: string,
  expectedDigest: string,
  expectedBytes: number,
): Promise<Uint8Array> => {
  const bytes = await readFile(path.join(root, source));
  if (bytes.byteLength !== expectedBytes || sha(bytes) !== expectedDigest) {
    throw new TypeError(`exported evidence changed before record assembly: ${source}`);
  }
  return bytes;
};

export const createLinkedComposedRecord = async (
  bootstrap: LinkedComposedBootstrap,
): Promise<ComposedRunRecord> => {
  const projectExtensions = await loadProjectViewerExtensions(
    path.join(bootstrap.trusted_project_root, "Simfile"),
  );
  const viewer = linkedComposedViewerManifestFields(
    bootstrap.preparation,
    projectExtensions,
  );
  const record = await createComposedRunRecord({
    identity: {
      contract_versions: {
        "simfile.composed-command-receipt.v1": "simfile.composed-command-receipt.v1",
        "simfile.composed-phase-journal.v1": "simfile.composed-phase-journal.v1",
        "simfile.composed-terminal-receipt.v1": "simfile.composed-terminal-receipt.v1",
        "simfile.composed-replay-receipt.v1": "simfile.composed-replay-receipt.v1",
        ...(viewer === undefined ? {} : {
          "simfile.composed-viewer-binding.v1": "simfile.composed-viewer-binding.v1",
        }),
      },
      created_at: new Date().toISOString(),
      run_id: bootstrap.run_id,
      spawnfile: { fingerprint: bootstrap.compile_fingerprint },
      world: {
        artifact_manifest_digest: bootstrap.request.world.artifact_manifest_digest,
        bundle_digest: bootstrap.request.world.bundle_digest,
        runtime_abi: bootstrap.request.world.runtime_abi,
        ...(viewer ?? {}),
      },
    },
    out_dir: bootstrap.run_path,
  });
  try {
    const extensions = await bindProjectViewerExtensions(projectExtensions);
    await record.writeArtifact({ bytes: extensions,
      path: "viewer-extensions.json", role: "presentation" });
    return record;
  } catch (error) {
    await record.abort();
    throw error;
  }
};

/** Reconciles both owners' preserved exports before atomically sealing the record. */
export const sealLinkedComposedRecord = async (input: Readonly<{
  bootstrap: LinkedComposedBootstrap;
  lifecycle: CompletedComposedRun;
  record: ComposedRunRecord;
}>): Promise<Awaited<ReturnType<ComposedRunRecord["seal"]>>> => {
  const world = parseComposedWorldEvidenceReceipt(
    composedPhasePayload(input.lifecycle.journal, "world_evidence_exported").evidence,
  );
  const worldInventory = new Map(world.inventory.map((item) => [item.path, item]));
  for (const artifact of input.bootstrap.preparation.evidence_artifacts) {
    const exported = worldInventory.get(artifact.source);
    if (exported === undefined) {
      throw new TypeError(`world evidence mapping is absent: ${artifact.source}`);
    }
    await input.record.writeArtifact({
      bytes: await correlatedBytes(input.bootstrap.world_evidence_directory,
        artifact.source, exported.sha256, exported.bytes),
      path: artifact.path, role: artifact.role,
    });
  }
  const organization = parseComposedOrganizationEvidenceReceipt(
    composedPhasePayload(input.lifecycle.journal, "organization_evidence_exported").evidence,
  );
  for (const artifact of organization.files) {
    await input.record.writeArtifact({
      bytes: await correlatedBytes(input.bootstrap.organization_evidence_directory,
        artifact.path, artifact.sha256, artifact.bytes),
      path: path.posix.join("organization", artifact.path),
      role: "authority-export",
    });
  }
  const exportIndex = await readFile(path.join(
    input.bootstrap.organization_evidence_directory, "spawnfile", "export-index.json",
  ));
  await input.record.writeArtifact({ bytes: exportIndex,
    path: "organization/spawnfile/export-index.json", role: "authority-export" });
  await input.record.writeArtifact({
    bytes: new TextEncoder().encode(`${canonicalComposedJson(input.lifecycle.journal)}\n`),
    path: "lifecycle/phase-journal.json", role: "provenance",
  });
  await input.record.writeArtifact({
    bytes: new TextEncoder().encode(`${canonicalComposedJson(input.lifecycle.receipt)}\n`),
    path: "lifecycle/terminal-receipt.json", role: "terminal",
  });
  await input.record.writeArtifact({
    bytes: await readFile(path.join(input.bootstrap.execution.provider.compiled_output_directory,
      "spawnfile-report.json")),
    path: "organization/spawnfile-report.json", role: "provenance",
  });
  return input.record.seal();
};
