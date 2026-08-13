import type { ComposedWorldEvidenceItem } from "../compose/finalize-world.js";
import type { TargetResourceReceipt } from "./targetReceipts.js";

const authorityForPath = (path: string): ComposedWorldEvidenceItem["authority"] => {
  if (path.startsWith("actions/")) return "actions";
  if (path.startsWith("checkpoints/")) return "checkpoints";
  if (path.startsWith("projections/") || path.startsWith(".spawnfile/")
    || !path.includes("/")) return "projections";
  throw new TypeError("Spawnfile exported an unrecognized world evidence item");
};

/** Derives B14 solely from the byte-derived, source-bound Spawnfile export index. */
export const worldInventoryFromTargetExport = (
  receipt: TargetResourceReceipt,
  evidenceVolumeHandle: string,
): readonly ComposedWorldEvidenceItem[] => {
  const index = receipt.evidence_index;
  if (receipt.operation !== "export_evidence_volume" || index === undefined
    || index.source.evidence_volume_handle !== evidenceVolumeHandle
    || index.source.state !== "preserved" || index.state !== "exported") {
    throw new TypeError("Spawnfile world evidence source is invalid");
  }
  const inventory = index.files.map((file) => ({
    authority: authorityForPath(file.path),
    bytes: file.bytes,
    path: file.path,
    sha256: file.sha256,
  }));
  const authorities = new Set(inventory.map(({ authority }) => authority));
  if ((["actions", "checkpoints", "projections"] as const)
    .some((authority) => !authorities.has(authority))) {
    throw new TypeError("Spawnfile world evidence inventory is incomplete");
  }
  return Object.freeze(inventory.map((item) => Object.freeze(item)));
};
