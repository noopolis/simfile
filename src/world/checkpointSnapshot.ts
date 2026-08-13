import { types } from "node:util";
import { DYNAMICS_LIMITS } from "../dynamics/limits.js";
import { copyCheckpointDynamicsSnapshot } from "./checkpointDynamicsSnapshot.js";
import { parseCapabilityManifest, serializeCapabilityManifest, type CapabilityManifest, type CapabilityManifestArtifact } from "./capabilityManifest.js";
import { parseDecisionRegistrySnapshot, type DecisionRegistrySnapshot } from "./decisionRegistrySnapshot.js";
import { parseWorldActionJournalSnapshot, type WorldActionJournalSnapshot } from "./actionJournalSnapshot.js";
import { parseWorldRequestLedgerSnapshot, type WorldRequestLedgerSnapshot } from "./requestLedgerSnapshot.js";
import { parseWorldReadLedgerSnapshot, type WorldReadLedgerSnapshot } from "./readLedgerSnapshot.js";
import { parseWorldActionResultLedgerSnapshot } from "./actionResultLedgerSnapshot.js";
import type { LedgerSnapshotState } from "./actionResultLedger.js";
import type { DynamicsSessionSnapshot } from "../dynamics/types.js";

const SHA256 = /^[a-f0-9]{64}$/u;
const MANIFEST_SHA256 = /^sha256:[a-f0-9]{64}$/u;
const dangerous = new Set(["__proto__", "constructor", "prototype"]);
const exact = (value: unknown, keys: readonly string[]): Record<string, unknown> | undefined => {
  if (value === null || typeof value !== "object" || Array.isArray(value) || types.isProxy(value as object)) return undefined;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return undefined;
  const own = Reflect.ownKeys(value);
  if (own.length !== keys.length || own.some((key) => typeof key !== "string" || dangerous.has(key) || !keys.includes(key))) return undefined;
  const output: Record<string, unknown> = Object.create(null);
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !("value" in descriptor)) return undefined;
    output[key] = descriptor.value;
  }
  return output;
};
const values = (value: unknown, maximum: number): readonly unknown[] | undefined => {
  if (!Array.isArray(value) || types.isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype) return undefined;
  const length = Object.getOwnPropertyDescriptor(value, "length");
  if (!length || !("value" in length) || !Number.isSafeInteger(length.value) || length.value < 0 || length.value > maximum) return undefined;
  const own = Reflect.ownKeys(value);
  if (own.length !== length.value + 1 || own.some((key) => typeof key !== "string" || (key !== "length" && (!/^(?:0|[1-9][0-9]*)$/u.test(key) || Number(key) >= length.value)))) return undefined;
  const output: unknown[] = [];
  for (let index = 0; index < length.value; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor?.enumerable || !("value" in descriptor)) return undefined;
    output.push(descriptor.value);
  }
  return output;
};
const scan = (value: unknown, seen: Set<object>, depth = 0): boolean => {
  if (depth > 24) return false;
  if (value === null || typeof value !== "object") return true;
  if (types.isProxy(value) || seen.has(value as object)) return false;
  seen.add(value as object);
  const array = Array.isArray(value);
  const prototype = Object.getPrototypeOf(value);
  if ((array && prototype !== Array.prototype) || (!array && prototype !== Object.prototype && prototype !== null)) return false;
  if (!array && Object.getOwnPropertyDescriptor(value, "then") !== undefined) return false;
  for (const key of Reflect.ownKeys(value)) {
    if (key === "length") continue;
    if (typeof key !== "string" || dangerous.has(key)) return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !("value" in descriptor)) return false;
    if (key !== "length" && !scan(descriptor.value, seen, depth + 1)) return false;
  }
  return true;
};
const bytes = (value: unknown): readonly number[] | undefined => {
  const raw = values(value, DYNAMICS_LIMITS.retained_action_code_units);
  if (raw === undefined || raw.length === 0) return undefined;
  const output = raw.map((entry) => typeof entry === "number" && Number.isInteger(entry) && entry >= 0 && entry <= 255 ? entry : -1);
  return output.some((entry) => entry < 0) ? undefined : Object.freeze(output);
};
const parseManifests = (input: unknown): readonly CapabilityManifestArtifact[] | undefined => {
  const raw = values(input, 4096);
  if (raw === undefined) return undefined;
  const output: CapabilityManifestArtifact[] = [];
  const principals = new Set<string>();
  for (const entry of raw) {
    const source = exact(entry, ["manifest", "bytes", "digest"]);
    const data = source === undefined ? undefined : bytes(source.bytes);
    if (source === undefined || data === undefined || typeof source.digest !== "string" || !MANIFEST_SHA256.test(source.digest)) return undefined;
    let manifest;
    try { manifest = parseCapabilityManifest(data); } catch { return undefined; }
    const canonical = serializeCapabilityManifest(manifest);
    const declared = serializeCapabilityManifest(source.manifest as CapabilityManifest);
    if (canonical.length !== data.length || canonical.some((byte, index) => byte !== data[index])
      || declared.length !== data.length || declared.some((byte, index) => byte !== data[index])
      || source.digest !== manifest.manifest_digest || principals.has(manifest.holder.principal)) return undefined;
    principals.add(manifest.holder.principal);
    output.push(Object.freeze({ manifest, bytes: data, digest: source.digest }));
  }
  output.sort((left, right) => left.manifest.holder.principal < right.manifest.holder.principal ? -1 : left.manifest.holder.principal > right.manifest.holder.principal ? 1 : 0);
  return Object.freeze(output);
};
const parseDecisions = (input: unknown): DecisionRegistrySnapshot | undefined => {
  const source = exact(input, ["version", "runId", "worldInstanceId", "tokenDigestKeyFingerprint", "phase", "cutoffTick", "admissionsClosedTick", "finalizedTick", "lastTick", "nextDecisionSequence", "decisions"]);
  if (source === undefined || typeof source.runId !== "string" || typeof source.worldInstanceId !== "string" || typeof source.tokenDigestKeyFingerprint !== "string") return undefined;
  const parsed = parseDecisionRegistrySnapshot(input, { runId: source.runId, worldInstanceId: source.worldInstanceId, tokenDigestKeyFingerprint: source.tokenDigestKeyFingerprint });
  if (parsed === undefined) return undefined;
  return Object.freeze({ ...source, ...parsed, version: source.version }) as DecisionRegistrySnapshot;
};

export interface WorldCheckpointStatic {
  readonly executed_artifact_sha256: string;
  /** Opaque issuer identity; C3 compares it with the live authoritative receipt. */
  readonly dynamics_build_receipt_sha256: string;
  readonly capability_manifests: readonly CapabilityManifestArtifact[];
}
export interface WorldCheckpointSnapshot { readonly static: WorldCheckpointStatic; readonly dynamics: DynamicsSessionSnapshot; readonly decisions: DecisionRegistrySnapshot; readonly action_journal: WorldActionJournalSnapshot; readonly request_ledger: WorldRequestLedgerSnapshot; readonly action_result_ledger: LedgerSnapshotState; readonly read_ledger: WorldReadLedgerSnapshot; }
export const copyWorldCheckpointSnapshot = (input: unknown): WorldCheckpointSnapshot | undefined => {
  try {
    const root = exact(input, ["version", "static", "dynamics", "decisions", "action_journal", "request_ledger", "action_result_ledger", "read_ledger"]);
    const staticValue = root === undefined ? undefined : exact(root.static, ["executed_artifact_sha256", "dynamics_build_receipt_sha256", "capability_manifests"]);
    if (root === undefined || root.version !== "simfile.world-checkpoint.v1" || staticValue === undefined
      || typeof staticValue.executed_artifact_sha256 !== "string" || !SHA256.test(staticValue.executed_artifact_sha256)
      || typeof staticValue.dynamics_build_receipt_sha256 !== "string" || !SHA256.test(staticValue.dynamics_build_receipt_sha256)) return undefined;
    const manifests = parseManifests(staticValue.capability_manifests);
    const dynamics = copyCheckpointDynamicsSnapshot(root.dynamics);
    const decisions = parseDecisions(root.decisions);
    const journal = parseWorldActionJournalSnapshot(root.action_journal);
    const requests = parseWorldRequestLedgerSnapshot(root.request_ledger);
    const results = parseWorldActionResultLedgerSnapshot(root.action_result_ledger);
    const reads = parseWorldReadLedgerSnapshot(root.read_ledger);
    if (manifests === undefined || dynamics === undefined || decisions === undefined || journal === undefined || requests === undefined || results === undefined || reads === undefined) return undefined;
    // Owner parsers establish caps and section shape before this whole-input alias graph check.
    if (!scan(input, new Set<object>())) return undefined;
    return Object.freeze({ static: Object.freeze({ executed_artifact_sha256: staticValue.executed_artifact_sha256, dynamics_build_receipt_sha256: staticValue.dynamics_build_receipt_sha256, capability_manifests: manifests }), dynamics, decisions, action_journal: journal, request_ledger: requests, action_result_ledger: results, read_ledger: reads });
  } catch { return undefined; }
};
