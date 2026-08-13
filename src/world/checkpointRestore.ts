import { isDeepStrictEqual } from "node:util";

import { DYNAMICS_LIMITS } from "../dynamics/limits.js";
import type { DynamicsSession } from "../dynamics/session.js";
import type { CapabilityManifestArtifact } from "./capabilityManifest.js";
import { createWorldActionJournal, type WorldActionJournal } from "./actionJournal.js";
import { createWorldActionResultLedger, readWorldActionResultLedger, type WorldActionResultLedger } from "./actionResultLedger.js";
import { snapshotWorldActionResultStore } from "./actionResultLedgerSnapshot.js";
import { WORLD_CHECKPOINT_VERSION, parseWorldCheckpoint, type WorldCheckpoint } from "./checkpoint.js";
import type { DecisionRegistry } from "./decisionRegistry.js";
import { readWorldReadLedger, type WorldReadLedger } from "./ledger.js";
import { createWorldRequestLedger, type WorldRequestLedger } from "./requestLedger.js";

const RESULT_ENTRIES = 256;
const RESULT_PRINCIPALS = 256;
const fail = (): never => { throw new Error("world checkpoint restore unavailable"); };
const sorted = (values: readonly string[]): readonly string[] => [...values].sort();
const exactPrincipals = (values: readonly string[], expected: readonly string[]): boolean =>
  isDeepStrictEqual(sorted(values), expected);

export interface WorldRuntimePrivateStores {
  readonly actionJournal: WorldActionJournal;
  readonly requestLedger: WorldRequestLedger;
  readonly actionResultLedger: WorldActionResultLedger;
}

interface WorldRuntimeCheckpointSources extends WorldRuntimePrivateStores {
  readonly dynamics: DynamicsSession;
  readonly capabilityManifests: readonly CapabilityManifestArtifact[];
  readonly decisionRegistry: DecisionRegistry;
  readonly readLedger: WorldReadLedger;
}

export const createWorldRuntimePrivateStores = (): WorldRuntimePrivateStores => Object.freeze({
  actionJournal: createWorldActionJournal(),
  requestLedger: createWorldRequestLedger({ max_records: DYNAMICS_LIMITS.retained_action_records - 1 }),
  actionResultLedger: createWorldActionResultLedger({
    maxEntriesPerPrincipal: RESULT_ENTRIES,
    maxPrincipals: RESULT_PRINCIPALS,
  }),
});

const capture = (sources: WorldRuntimeCheckpointSources): WorldCheckpoint => parseWorldCheckpoint({
  version: WORLD_CHECKPOINT_VERSION,
  static: {
    executed_artifact_sha256: sources.dynamics.provenance.module_sha256,
    dynamics_build_receipt_sha256: sources.dynamics.buildReceipt.receiptSha256,
    capability_manifests: sources.capabilityManifests,
  },
  dynamics: sources.dynamics.snapshot(),
  decisions: sources.decisionRegistry.snapshot(),
  action_journal: sources.actionJournal.snapshot(),
  request_ledger: sources.requestLedger.snapshot(),
  action_result_ledger: snapshotWorldActionResultStore(sources.actionResultLedger),
  read_ledger: readWorldReadLedger(sources.readLedger)?.snapshot(),
}) ?? fail();

const assertExactWorldRuntimeCheckpoint = (
  expected: WorldCheckpoint,
  sources: WorldRuntimeCheckpointSources,
): void => {
  if (!isDeepStrictEqual(capture(sources), expected)) fail();
};

export interface RestoreWorldRuntimeCheckpointInput {
  readonly checkpoint: unknown;
  readonly dynamics: DynamicsSession;
  readonly capabilityManifests: readonly CapabilityManifestArtifact[];
  readonly decisionRegistry: DecisionRegistry;
  readonly readLedger: WorldReadLedger;
  available(): boolean;
  consume(): void;
}

export interface RestoredWorldRuntimeState extends WorldRuntimePrivateStores {
  readonly checkpoint: WorldCheckpoint;
  readonly mechanicsClosed: boolean;
}

export const restoreWorldRuntimeCheckpoint = (
  input: RestoreWorldRuntimeCheckpointInput,
): RestoredWorldRuntimeState => {
  const checkpoint = parseWorldCheckpoint(input.checkpoint) ?? fail();
  const manifests = [...input.capabilityManifests].sort((left, right) =>
    left.manifest.holder.principal < right.manifest.holder.principal ? -1
      : left.manifest.holder.principal > right.manifest.holder.principal ? 1 : 0);
  const principals = sorted(manifests.map((artifact) => artifact.manifest.holder.principal));
  const dynamics = input.dynamics.snapshot();
  const decisions = input.decisionRegistry.snapshot();
  const readAuthority = readWorldReadLedger(input.readLedger) ?? fail();
  const reads = readAuthority.snapshot();
  const bindings = manifests.map(({ manifest }) => ({
    principal: manifest.holder.principal,
    actor: manifest.holder.entity,
    run_id: manifest.run_id,
    world_id: manifest.world.id,
    world_instance_id: manifest.world.instance_id,
    manifest_digest: manifest.manifest_digest,
  }));
  const freshDynamics = dynamics.next_tick === 0 && dynamics.next_action_sequence === 1
    && dynamics.next_event_sequence === 1 && dynamics.accepted_action_sequences.floor === 1
    && dynamics.accepted_action_sequences.above_floor.length === 0
    && dynamics.action_ingress.length === 0 && dynamics.pending_actions.length === 0
    && dynamics.action_ingress_floor === 1 && dynamics.action_ingress_ordinal === 0
    && dynamics.resolved_action_sequences.floor === 1
    && dynamics.resolved_action_sequences.above_floor.length === 0;
  const freshDecisions = decisions.phase === "open" && decisions.cutoffTick === null
    && decisions.admissionsClosedTick === null && decisions.finalizedTick === null
    && decisions.lastTick === null && decisions.nextDecisionSequence === 1
    && decisions.decisions.length === 0;
  if (!freshDynamics || !freshDecisions || reads.lanes.length !== 0
    || checkpoint.static.executed_artifact_sha256 !== input.dynamics.provenance.module_sha256
    || checkpoint.static.dynamics_build_receipt_sha256 !== input.dynamics.buildReceipt.receiptSha256
    || !isDeepStrictEqual(checkpoint.static.capability_manifests, manifests)
    || !isDeepStrictEqual(checkpoint.dynamics.provenance, dynamics.provenance)
    || checkpoint.dynamics.seed !== dynamics.seed
    || checkpoint.dynamics.sim_seconds_per_tick !== dynamics.sim_seconds_per_tick
    || checkpoint.decisions.runId !== decisions.runId
    || checkpoint.decisions.worldInstanceId !== decisions.worldInstanceId
    || checkpoint.decisions.tokenDigestKeyFingerprint !== decisions.tokenDigestKeyFingerprint
    || checkpoint.request_ledger.record_count > DYNAMICS_LIMITS.retained_action_records - 1
    || checkpoint.request_ledger.code_units > DYNAMICS_LIMITS.retained_action_code_units
    || checkpoint.action_result_ledger.max_entries !== RESULT_ENTRIES
    || checkpoint.action_result_ledger.max_principals !== RESULT_PRINCIPALS
    || checkpoint.read_ledger.max_entries_per_principal !== reads.max_entries_per_principal
    || checkpoint.read_ledger.max_principals !== reads.max_principals
    || !exactPrincipals(checkpoint.action_journal.lanes.map((lane) => lane.principal), principals)
    || !isDeepStrictEqual(checkpoint.action_result_ledger.bindings, bindings)
    || !exactPrincipals(checkpoint.read_ledger.lanes.map((lane) => lane.principal), principals)
    || checkpoint.action_journal.closed !== checkpoint.request_ledger.closed) fail();

  if (!input.available()) fail();
  const stores = createWorldRuntimePrivateStores();
  const resultAuthority = readWorldActionResultLedger(stores.actionResultLedger) ?? fail();
  input.dynamics.restore(checkpoint.dynamics);
  input.decisionRegistry.restore(checkpoint.decisions);
  stores.actionJournal.restore(checkpoint.action_journal);
  stores.requestLedger.restore(checkpoint.request_ledger);
  resultAuthority.importState(checkpoint.action_result_ledger);
  readAuthority.restore(checkpoint.read_ledger);
  assertExactWorldRuntimeCheckpoint(checkpoint, {
    ...stores,
    dynamics: input.dynamics,
    capabilityManifests: input.capabilityManifests,
    decisionRegistry: input.decisionRegistry,
    readLedger: input.readLedger,
  });
  input.consume();
  return Object.freeze({ ...stores, checkpoint, mechanicsClosed: checkpoint.action_journal.closed });
};
