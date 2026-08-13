import { canonicalDynamicsJson } from "../dynamics/canonicalJson.js";
import { digestDynamicsActionAttempt } from "../dynamics/actionRetention.js";
import type { DynamicsSessionSnapshot } from "../dynamics/types.js";
import type { CapabilityManifestArtifact } from "./capabilityManifest.js";
import type { DecisionRegistrySnapshot } from "./decisionRegistrySnapshot.js";
import type { WorldActionJournalSnapshot } from "./actionJournalSnapshot.js";
import type { WorldRequestLedgerSnapshot } from "./requestLedgerSnapshot.js";
import type { LedgerSnapshotState } from "./actionResultLedger.js";
import type { WorldReadLedgerSnapshot } from "./readLedgerSnapshot.js";
import type { WorldCheckpointStatic, WorldCheckpointSnapshot } from "./checkpointSnapshot.js";

type Identity = { readonly run_id: string; readonly world_id: string; readonly world_instance_id: string; readonly manifest_digest: string; readonly state_version: number };
type Manifests = { readonly digest: Map<string, CapabilityManifestArtifact>; readonly principal: Map<string, CapabilityManifestArtifact> };
const indexes = (items: readonly CapabilityManifestArtifact[]): Manifests => ({
  digest: new Map(items.map((item) => [item.digest, item])), principal: new Map(items.map((item) => [item.manifest.holder.principal, item])),
});
const sameJson = (left: unknown, right: unknown): boolean => canonicalDynamicsJson(left) === canonicalDynamicsJson(right);
const sameStatic = (left: Identity, right: Identity): boolean => left.run_id === right.run_id && left.world_id === right.world_id
  && left.world_instance_id === right.world_instance_id && left.manifest_digest === right.manifest_digest;
const tick = (value: number | null | undefined, frontier: number): boolean => value === null || value === undefined || (Number.isSafeInteger(value) && value >= 0 && value <= frontier);
const successor = (value: number): number | undefined => Number.isSafeInteger(value) && value >= 0 && value < Number.MAX_SAFE_INTEGER ? value + 1 : undefined;

const staticRelations = (value: WorldCheckpointStatic, dynamics: DynamicsSessionSnapshot, decisions: DecisionRegistrySnapshot,
  journal: WorldActionJournalSnapshot, requests: WorldRequestLedgerSnapshot, results: LedgerSnapshotState, reads: WorldReadLedgerSnapshot): boolean => {
  const manifests = indexes(value.capability_manifests);
  if (dynamics.provenance.module_sha256 !== value.executed_artifact_sha256 || manifests.digest.size !== value.capability_manifests.length || manifests.principal.size !== value.capability_manifests.length) return false;
  const first = value.capability_manifests[0]?.manifest;
  for (const artifact of value.capability_manifests) {
    const manifest = artifact.manifest;
    if (artifact.digest !== manifest.manifest_digest || first !== undefined && (manifest.run_id !== first.run_id || manifest.world.id !== first.world.id
      || manifest.world.instance_id !== first.world.instance_id || manifest.surface.registry_digest !== first.surface.registry_digest)) return false;
  }
  const empty = decisions.decisions.length === 0 && journal.lanes.length === 0 && journal.audits.length === 0 && journal.cells.length === 0
    && requests.records.length === 0 && results.bindings.length === 0 && results.entries.length === 0 && results.admitted === 0 && reads.lanes.length === 0;
  if (first === undefined) return empty;
  if (decisions.runId !== first.run_id || decisions.worldInstanceId !== first.world.instance_id) return false;
  const manifestFor = (item: Identity | undefined, principal: string): CapabilityManifestArtifact | undefined => {
    const manifest = item === undefined ? undefined : manifests.digest.get(item.manifest_digest);
    return manifest !== undefined && manifest.manifest.holder.principal === principal && item !== undefined
      && item.run_id === first.run_id && item.world_id === first.world.id && item.world_instance_id === first.world.instance_id ? manifest : undefined;
  };
  const frontier = dynamics.next_tick;
  if (!Number.isSafeInteger(frontier) || frontier < 0) return false;
  for (const decision of decisions.decisions) if (!manifests.principal.has(decision.principal) || !tick(decision.issuedTick, frontier)
    || decision.validThroughTick < decision.issuedTick) return false;
  if (!tick(decisions.lastTick, frontier) || !tick(decisions.cutoffTick, frontier) || !tick(decisions.admissionsClosedTick, frontier) || !tick(decisions.finalizedTick, frontier)) return false;
  for (const lane of journal.lanes) if (!manifests.principal.has(lane.principal)) return false;
  for (const audit of journal.audits) if (!manifests.principal.has(audit.principal)) return false;
  for (const cell of journal.cells) if (manifestFor(cell.record.identity, cell.record.principal) === undefined || manifestFor(cell.receipt.identity, cell.record.principal) === undefined
    || cell.record.identity.state_version !== cell.record.at_tick || cell.receipt.identity.state_version !== cell.receipt.apply_tick || !tick(cell.record.at_tick, frontier) || !tick(cell.receipt.apply_tick, frontier)) return false;
  for (const request of requests.records) if (manifestFor(request.receipt.identity, request.authority.principal) === undefined
    || request.authority.run_id !== request.receipt.identity.run_id || request.authority.world_id !== request.receipt.identity.world_id || request.authority.world_instance_id !== request.receipt.identity.world_instance_id
    || !tick(request.at_tick, frontier)) return false;
  for (const lane of reads.lanes) {
    if (!manifests.principal.has(lane.principal)) return false;
    for (const record of lane.records) {
      if (record.principal !== lane.principal || record.state_version !== undefined && !tick(record.state_version, frontier)) return false;
      if (record.result === "allowed" && (record.identity === undefined || record.decision_id === undefined || manifestFor(record.identity, record.principal) === undefined)) return false;
    }
  }
  for (const binding of results.bindings) {
    const manifest = manifests.digest.get(binding.manifest_digest);
    if (manifest === undefined || manifest.manifest.holder.principal !== binding.principal || manifest.manifest.holder.entity !== binding.actor
      || binding.run_id !== first.run_id || binding.world_id !== first.world.id || binding.world_instance_id !== first.world.instance_id) return false;
  }
  for (const entry of results.entries) for (const retained of entry.values) if (!tick(retained.result.identity.state_version, frontier)) return false;
  return true;
};

const manifestRelations = (manifests: Manifests, journal: WorldActionJournalSnapshot): boolean => {
  const grants = new Map<string, Map<string, { readonly holder: string; readonly targets: Set<string> | undefined }>>();
  for (const [principal, artifact] of manifests.principal) {
    const affordances = new Map<string, { readonly holder: string; readonly targets: Set<string> | undefined }>();
    for (const item of artifact.manifest.affordances) affordances.set(item.address, { holder: artifact.manifest.holder.entity, targets: item.target_selector.kind === "holder" ? undefined : new Set(item.target_selector.targets) });
    grants.set(principal, affordances);
  }
  for (const cell of journal.cells) {
    const grant = grants.get(cell.record.principal)?.get(cell.record.affordance);
    if (grant === undefined || cell.record.holder !== grant.holder || (grant.targets === undefined ? cell.record.target !== grant.holder : !grant.targets.has(cell.record.target))) return false;
  }
  return true;
};

const dynamicsRelations = (dynamics: DynamicsSessionSnapshot, journal: WorldActionJournalSnapshot): boolean => {
  const ingress = new Map<number, (typeof dynamics.action_ingress)[number]>();
  for (const item of dynamics.action_ingress) if (item.receipt.queued && item.receipt.sequence !== undefined) ingress.set(item.receipt.sequence, item);
  const cells = new Map(journal.cells.map((cell) => [cell.sequence, cell]));
  const pending = new Set(dynamics.pending_actions.map((item) => item.sequence));
  const contains = (watermark: DynamicsSessionSnapshot["resolved_action_sequences"], sequence: number): boolean =>
    sequence < watermark.floor || watermark.above_floor.includes(sequence);
  for (const [sequence, item] of ingress) {
    const cell = cells.get(sequence);
    if (cell === undefined || cell.receipt.receipt_id !== item.receipt.act_id || cell.record.principal !== item.principal_id
      || cell.record.at_tick !== item.at_tick || cell.receipt.apply_tick !== item.receipt.apply_tick
      || item.attempt_sha256 !== digestDynamicsActionAttempt({
        act_id: cell.receipt.receipt_id, action: cell.record.mechanics_action,
        actor: cell.record.mechanics_actor, at_tick: cell.record.at_tick,
        input: cell.record.lowered_input, origin: "agentic", principal_id: cell.record.principal,
        target: cell.record.mechanics_target
      })) return false;
  }
  for (const cell of journal.cells) {
    const resolved = contains(dynamics.resolved_action_sequences, cell.sequence);
    const accepted = contains(dynamics.accepted_action_sequences, cell.sequence);
    if (pending.has(cell.sequence) !== (cell.state === "authorized")
      || resolved !== (cell.state === "terminal")
      || accepted !== (cell.terminal?.disposition === "applied")) return false;
  }
  return [...pending].every((sequence) => ingress.has(sequence));
};

const requestRelations = (requests: WorldRequestLedgerSnapshot, journal: WorldActionJournalSnapshot): boolean => {
  const bySequence = new Map(journal.cells.map((cell) => [cell.sequence, cell]));
  const seen = new Set<number>();
  for (const request of requests.records) {
    const cell = bySequence.get(request.queued_action.dynamics_sequence);
    if (cell === undefined || seen.has(request.queued_action.dynamics_sequence) || request.at_tick !== cell.record.at_tick || request.receipt.receipt_id !== cell.receipt.receipt_id || request.receipt.decision_id !== cell.receipt.decision_id
      || request.receipt.apply_tick !== cell.receipt.apply_tick || request.queued_action.receipt_id !== cell.record.receipt_id || request.queued_action.decision_id !== cell.record.decision_id
      || request.queued_action.principal !== cell.record.principal || request.queued_action.holder !== cell.record.holder || request.queued_action.affordance !== cell.record.affordance
      || request.queued_action.target !== cell.record.target || request.queued_action.at_tick !== cell.record.at_tick || request.queued_action.mechanics_action !== cell.record.mechanics_action
      || request.queued_action.mechanics_actor !== cell.record.mechanics_actor || request.queued_action.mechanics_target !== cell.record.mechanics_target || !sameJson(request.queued_action.lowered_input, cell.record.lowered_input)
      || !sameStatic(request.queued_action.identity, cell.record.identity) || request.queued_action.identity.state_version !== cell.record.identity.state_version
      || !sameStatic(request.receipt.identity, cell.receipt.identity)) return false;
    seen.add(request.queued_action.dynamics_sequence);
  }
  return seen.size === journal.cells.length;
};

const resultRelations = (results: LedgerSnapshotState, journal: WorldActionJournalSnapshot, manifests: Manifests): boolean => {
  const terminals = journal.cells.filter((cell) => cell.terminal !== null), terminalReceipts = new Set(terminals.map((cell) => cell.receipt.receipt_id));
  const terminalDecisions = new Set(terminals.map((cell) => cell.terminal!.decision_id)), terminalActions = new Set(terminals.map((cell) => cell.sequence));
  const exact = <T>(values: readonly T[], expected: Set<T>): boolean => values.length === expected.size && new Set(values).size === values.length && values.every((value) => expected.has(value));
  if (!exact(results.receipt_ids, terminalReceipts) || !exact(results.decision_ids, terminalDecisions) || !exact(results.action_sequences, terminalActions)) return false;
  const terminalsByReceipt = new Map(terminals.map((cell) => [cell.receipt.receipt_id, cell]));
  const retained = new Map<string, LedgerSnapshotState["entries"][number]["values"][number]["result"]>();
  const owners = new Map(results.bindings.map((binding) => [binding.principal, binding]));
  for (const entry of results.entries) for (const value of entry.values) {
    const result = value.result, cell = terminalsByReceipt.get(result.receipt_id), owner = owners.get(entry.principal), manifest = manifests.principal.get(entry.principal), next = successor(cell?.terminal?.apply_tick ?? -1);
    if (cell === undefined || owner === undefined || manifest === undefined || retained.has(result.receipt_id) || result.actor !== owner.actor || result.actor !== manifest.manifest.holder.entity
      || result.decision_id !== cell.terminal!.decision_id || result.action_sequence !== cell.sequence || result.apply_tick !== cell.terminal!.apply_tick || next === undefined
      || result.identity.state_version !== next || !sameStatic(result.identity, cell.record.identity) || (result.status === "applied" ? cell.terminal!.disposition !== "applied" : cell.terminal!.disposition === "applied")
      || result.status === "rejected_at_mechanics" && result.rejection_code !== (cell.terminal!.public_code ?? "world_action_rejected")) return false;
    retained.set(result.receipt_id, result);
  }
  for (const cell of journal.cells) if (cell.state === "authorized" && (results.receipt_ids.includes(cell.receipt.receipt_id) || results.decision_ids.includes(cell.record.decision_id)
    || results.action_sequences.includes(cell.sequence) || retained.has(cell.receipt.receipt_id))) return false;
  return true;
};

const decisionRelations = (decisions: DecisionRegistrySnapshot, journal: WorldActionJournalSnapshot, reads: WorldReadLedgerSnapshot): boolean => {
  const known = new Map(decisions.decisions.map((decision) => [decision.decisionId, decision]));
  for (const cell of journal.cells) { const decision = known.get(cell.record.decision_id); if (decision === undefined || decision.principal !== cell.record.principal || decision.status !== "consumed") return false; }
  for (const lane of reads.lanes) for (const record of lane.records) if (record.result === "allowed") {
    const decision = record.decision_id === undefined ? undefined : known.get(record.decision_id);
    if (decision === undefined || decision.principal !== record.principal || record.state_version === undefined || record.state_version < decision.issuedTick || record.state_version > decision.validThroughTick) return false;
  }
  return true;
};

export const validateWorldCheckpointRelations = (checkpoint: WorldCheckpointSnapshot): boolean => {
  try {
    const { static: value, dynamics, decisions, action_journal: journal, request_ledger: requests, action_result_ledger: results, read_ledger: reads } = checkpoint;
    const manifests = indexes(value.capability_manifests);
    return staticRelations(value, dynamics, decisions, journal, requests, results, reads) && manifestRelations(manifests, journal)
      && dynamicsRelations(dynamics, journal) && requestRelations(requests, journal) && resultRelations(results, journal, manifests) && decisionRelations(decisions, journal, reads);
  } catch { return false; }
};
