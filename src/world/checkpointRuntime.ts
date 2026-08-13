import { readCheckedDynamicsSession, type DynamicsSession } from "../dynamics/session.js";
import { readWorldActionJournal, type WorldActionJournal } from "./actionJournal.js";
import { snapshotWorldActionResultStore } from "./actionResultLedgerSnapshot.js";
import { readWorldActionResultLedger, type WorldActionResultLedger } from "./actionResultLedger.js";
import { WORLD_CHECKPOINT_VERSION, parseWorldCheckpoint, type WorldCheckpoint } from "./checkpoint.js";
import type { CapabilityManifestArtifact } from "./capabilityManifest.js";
import { readWorldRuntimeClockAuthority } from "./clockAuthority.js";
import { readDecisionRegistry, type DecisionRegistry } from "./decisionRegistry.js";
import { readWorldReadLedger, type WorldReadLedger } from "./ledger.js";
import { readWorldRequestLedger, type WorldRequestLedger } from "./requestLedger.js";

export interface WorldRuntimeCheckpointCoordinator {
  capture(): WorldCheckpoint;
}

interface CheckpointOperation {
  enter(): void;
  leave(): void;
  stable(): boolean;
}

interface WorldRuntimeCheckpointRegistration {
  readonly dynamics: DynamicsSession;
  readonly capabilityManifests: readonly CapabilityManifestArtifact[];
  readonly decisionRegistry: DecisionRegistry;
  readonly actionJournal: WorldActionJournal;
  readonly requestLedger: WorldRequestLedger;
  readonly actionResultLedger: WorldActionResultLedger;
  readonly readLedger: WorldReadLedger;
  readonly operation: CheckpointOperation;
}

const coordinators = new WeakMap<object, WorldRuntimeCheckpointCoordinator>();
const invalid = (): never => { throw new Error("world checkpoint capture unavailable"); };

export const registerWorldRuntimeCheckpointCoordinator = (
  runtime: object,
  registration: WorldRuntimeCheckpointRegistration,
): void => {
  const dynamics = readCheckedDynamicsSession(registration.dynamics) ?? invalid();
  const decisionRegistry = readDecisionRegistry(registration.decisionRegistry) ?? invalid();
  const actionJournal = readWorldActionJournal(registration.actionJournal) ?? invalid();
  const requestLedger = readWorldRequestLedger(registration.requestLedger) ?? invalid();
  const actionResultAuthority = readWorldActionResultLedger(registration.actionResultLedger) ?? invalid();
  const readLedgerAuthority = readWorldReadLedger(registration.readLedger) ?? invalid();
  if (readWorldRuntimeClockAuthority(runtime) === undefined || coordinators.has(runtime)
    || !Array.isArray(registration.capabilityManifests) || registration.capabilityManifests.length === 0
    || typeof registration.operation.enter !== "function" || typeof registration.operation.leave !== "function"
    || typeof registration.operation.stable !== "function") invalid();

  const capture = (): WorldCheckpoint => {
    let entered = false;
    try {
      registration.operation.enter();
      entered = true;
      const checkpoint = parseWorldCheckpoint({
        version: WORLD_CHECKPOINT_VERSION,
        static: {
          executed_artifact_sha256: dynamics.provenance.module_sha256,
          dynamics_build_receipt_sha256: dynamics.buildReceipt.receiptSha256,
          capability_manifests: registration.capabilityManifests,
        },
        dynamics: dynamics.snapshot(),
        decisions: decisionRegistry.snapshot(),
        action_journal: actionJournal.snapshot(),
        request_ledger: requestLedger.snapshot(),
        action_result_ledger: snapshotWorldActionResultStore(registration.actionResultLedger),
        read_ledger: readLedgerAuthority.snapshot(),
      }) ?? invalid();
      if (!registration.operation.stable()) invalid();
      return checkpoint;
    } finally {
      if (entered) registration.operation.leave();
    }
  };
  coordinators.set(runtime, Object.freeze({ capture }));
};

export const readWorldRuntimeCheckpointCoordinator = (
  runtime: unknown,
): WorldRuntimeCheckpointCoordinator | undefined =>
  runtime !== null && typeof runtime === "object" && readWorldRuntimeClockAuthority(runtime) !== undefined
    ? coordinators.get(runtime)
    : undefined;
