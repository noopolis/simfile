import { isDeepStrictEqual, types } from "node:util";
import { readCheckedDynamicsSession, type DynamicsSession } from "../dynamics/session.js";
import type { WorldSurfaceRegistry } from "../world-surface/index.js";
import { readParsedWorldSurfaceRegistry } from "../world-surface/definition.js";
import { compileCapabilityManifests, parseCapabilityManifest, serializeCapabilityManifest, type CapabilityManifest, type CapabilityManifestArtifact } from "./capabilityManifest.js";
import { readDecisionRegistry, type DecisionReadAdmission, type DecisionRegistry } from "./decisionRegistry.js";
import { createDecisionResultReadAdmission } from "./decisionResultReadAdmission.js";
import type { BoundWorldGrant } from "./grants.js";
import { readBoundWorldGrants } from "./grantAttestation.js";
import { parseWorldReadLedgerRecord, parseWorldReadLedgerRequest, readWorldReadLedger, WorldRuntimeError, type WorldReadIdentity, type WorldReadLedger, type WorldReadLedgerAuthority, type WorldReadLedgerPage, type WorldReadLedgerRecord, type WorldReadOperation } from "./ledger.js";
import { observeWorldRuntime, type WorldRuntimeObservation } from "./observe.js";
import { affordancesWorldRuntime, type WorldRuntimeAffordances } from "./affordances.js";
import { actWorldRuntime } from "./act.js";
import type { WorldActIngressReceipt } from "./actTypes.js";
import { createWorldRuntimeClockAuthority } from "./clockAuthority.js";
import { createWorldRuntimeControllerAuthority } from "./controllerAuthority.js";
import { registerWorldRuntimeActionJournalInspection, registerWorldRuntimeActionRefusalJournalInspection } from "./actionJournalInspection.js";
import { createWorldActionRefusalJournal } from "./actionRefusalJournal.js";
import { registerWorldRuntimeRequestLedgerInspection } from "./requestLedgerInspection.js";
import { parseWorldActionResultPageRequest, readWorldActionResultLedger, type WorldActionResultPage } from "./actionResultLedger.js";
import { registerWorldRuntimeActionResultLedgerInspection } from "./actionResultLedgerInspection.js";
import { readWorldRuntimeCheckpointCoordinator, registerWorldRuntimeCheckpointCoordinator } from "./checkpointRuntime.js";
import { createWorldRuntimePrivateStores, restoreWorldRuntimeCheckpoint } from "./checkpointRestore.js";
import { createWorldDecisionClaimAuthority, registerWorldDecisionClaimAuthority } from "./decisionClaim.js";
export interface AuthenticatedWorldContext { readonly principal: string; readonly decisionToken: string; }
/** The sole exact host-owned runtime construction contract. */
export const WORLD_RUNTIME_INPUT_FIELDS = [
  "dynamics", "surfaceRegistry", "capabilityManifests", "boundGrants", "decisionRegistry", "readLedger",
] as const;
export interface CreateWorldRuntimeInput {
  readonly dynamics: DynamicsSession; readonly surfaceRegistry: WorldSurfaceRegistry;
  readonly capabilityManifests: readonly CapabilityManifestArtifact[]; readonly boundGrants: readonly BoundWorldGrant[];
  readonly decisionRegistry: DecisionRegistry; readonly readLedger: WorldReadLedger;
}
export interface WorldRuntimeIdentity extends WorldReadIdentity {}
export interface WorldRuntimeStatus { readonly identity: WorldRuntimeIdentity; readonly orientation: { readonly holder_entity: string }; readonly decision: { readonly id: string; readonly phase: "open" | "cutoff"; readonly issued_at_tick: number; readonly valid_through_tick: number }; }
export interface WorldRuntimeCapabilities { readonly identity: WorldRuntimeIdentity; readonly manifest: CapabilityManifest; }
export interface WorldRuntimeLedger { readonly identity: WorldRuntimeIdentity; readonly records: WorldReadLedgerPage["records"]; readonly next_after: number; }
export interface WorldRuntimeResultLedger { readonly identity: WorldRuntimeIdentity; readonly results: WorldActionResultPage["results"]; readonly next_result_after?: WorldActionResultPage["next_result_after"]; }
export interface WorldRuntime { status(context: AuthenticatedWorldContext): WorldRuntimeStatus; capabilities(context: AuthenticatedWorldContext): WorldRuntimeCapabilities; observe(context: AuthenticatedWorldContext, request: unknown): WorldRuntimeObservation; affordances(context: AuthenticatedWorldContext): WorldRuntimeAffordances; ledger<T extends unknown>(context: AuthenticatedWorldContext, request?: T): T extends { readonly version: "simfile.world-action-result-page-request.v1" } ? WorldRuntimeResultLedger : WorldRuntimeLedger; act(context: AuthenticatedWorldContext, envelope: Uint8Array): WorldActIngressReceipt; }
type CheckedContext = { readonly principal?: string; readonly token?: string };
type Composition = { readonly runId: string; readonly worldId: string; readonly worldInstanceId: string; readonly manifests: ReadonlyMap<string, CapabilityManifest> };
type Dependencies = Readonly<{ dynamics: DynamicsSession; surfaceRegistry: WorldSurfaceRegistry; capabilityManifests: readonly CapabilityManifestArtifact[]; decisionRegistry: DecisionRegistry; readLedger: WorldReadLedgerAuthority; ledgerHandle: WorldReadLedger }>;

const claimedDynamics = new WeakSet<object>();
const claimedDecisionRegistries = new WeakSet<object>();
const claimedLedgers = new WeakSet<object>();
const stagedDynamics = new WeakMap<object, object>();
const stagedDecisionRegistries = new WeakMap<object, object>();
const stagedLedgers = new WeakMap<object, object>();
const denied = (): never => { throw new WorldRuntimeError("world_runtime_denied"); };
const invalidComposition = (): never => { throw new WorldRuntimeError("world_runtime_invalid_composition"); };
type WorldRuntimeOwnerLease = Readonly<{ available(): boolean; consume(): void; release(): void }>;
const stageWorldRuntimeOwners = (dependencies: Dependencies): WorldRuntimeOwnerLease => {
  const token = {};
  if (claimedDynamics.has(dependencies.dynamics) || claimedDecisionRegistries.has(dependencies.decisionRegistry)
    || claimedLedgers.has(dependencies.ledgerHandle) || stagedDynamics.has(dependencies.dynamics)
    || stagedDecisionRegistries.has(dependencies.decisionRegistry) || stagedLedgers.has(dependencies.ledgerHandle)) {
    return invalidComposition();
  }
  stagedDynamics.set(dependencies.dynamics, token);
  stagedDecisionRegistries.set(dependencies.decisionRegistry, token);
  stagedLedgers.set(dependencies.ledgerHandle, token);
  let active = true;
  const owns = (): boolean => active && stagedDynamics.get(dependencies.dynamics) === token
    && stagedDecisionRegistries.get(dependencies.decisionRegistry) === token
    && stagedLedgers.get(dependencies.ledgerHandle) === token;
  const release = (): void => {
    if (!owns()) return;
    stagedDynamics.delete(dependencies.dynamics);
    stagedDecisionRegistries.delete(dependencies.decisionRegistry);
    stagedLedgers.delete(dependencies.ledgerHandle);
    active = false;
  };
  return Object.freeze({
    available: (): boolean => owns() && !claimedDynamics.has(dependencies.dynamics)
      && !claimedDecisionRegistries.has(dependencies.decisionRegistry)
      && !claimedLedgers.has(dependencies.ledgerHandle),
    consume: (): void => {
      if (!owns() || claimedDynamics.has(dependencies.dynamics)
        || claimedDecisionRegistries.has(dependencies.decisionRegistry)
        || claimedLedgers.has(dependencies.ledgerHandle)) return invalidComposition();
      claimedDynamics.add(dependencies.dynamics);
      claimedDecisionRegistries.add(dependencies.decisionRegistry);
      claimedLedgers.add(dependencies.ledgerHandle);
      // Every permanent marker exists before any staging marker is removed.
      release();
    },
    release,
  });
};
const isProxy = (value: unknown): boolean => value !== null && typeof value === "object" && types.isProxy(value as object);
const binding = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 256 && value === value.trim();
const safeInteger = (value: unknown, minimum = 0): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= minimum;
const dataObject = (value: unknown, fields: readonly string[], exact = true): Record<string, unknown> | undefined => {
  if (value === null || typeof value !== "object" || Array.isArray(value) || isProxy(value) || Object.getPrototypeOf(value) !== Object.prototype) return undefined;
  const keys = Reflect.ownKeys(value);
  if ((exact && keys.length !== fields.length) || keys.some((key) => typeof key !== "string" || !fields.includes(key))) return undefined;
  const output: Record<string, unknown> = Object.create(null);
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !("value" in descriptor)) return undefined;
    output[key as string] = descriptor.value;
  }
  return output;
};
const dataArray = (value: unknown): readonly unknown[] | undefined => {
  if (!Array.isArray(value) || isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype) return undefined;
  const length = Object.getOwnPropertyDescriptor(value, "length");
  if (!length || !("value" in length) || !Number.isSafeInteger(length.value) || Reflect.ownKeys(value).length !== length.value + 1) return undefined;
  const output: unknown[] = [];
  for (let index = 0; index < length.value; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor?.enumerable || !("value" in descriptor)) return undefined;
    output.push(descriptor.value);
  }
  return output;
};
const equalBytes = (left: readonly number[], right: readonly number[]): boolean => left.length === right.length && left.every((byte, index) => byte === right[index]);
const cloneManifest = (value: CapabilityManifest): CapabilityManifest => parseCapabilityManifest(serializeCapabilityManifest(value));
const freezeIdentity = (manifest: CapabilityManifest, stateVersion: number): WorldRuntimeIdentity => Object.freeze({ run_id: manifest.run_id, world_id: manifest.world.id, world_instance_id: manifest.world.instance_id, manifest_digest: manifest.manifest_digest, state_version: stateVersion });

const safeContext = (input: unknown): CheckedContext => {
  if (input === null || typeof input !== "object" || Array.isArray(input) || isProxy(input) || Object.getPrototypeOf(input) !== Object.prototype) return {};
  const principal = Object.getOwnPropertyDescriptor(input, "principal"); const token = Object.getOwnPropertyDescriptor(input, "decisionToken");
  const safePrincipal = principal?.enumerable && "value" in principal && binding(principal.value) ? principal.value : undefined;
  const safeToken = token?.enumerable && "value" in token && typeof token.value === "string" ? token.value : undefined;
  return Reflect.ownKeys(input).length === 2 ? { principal: safePrincipal, token: safeToken } : { principal: safePrincipal };
};
const checkedArtifacts = (input: unknown): readonly CapabilityManifestArtifact[] | undefined => {
  const items = dataArray(input); if (items === undefined || items.length === 0) return undefined;
  const output: CapabilityManifestArtifact[] = [];
  for (const item of items) {
    const artifact = dataObject(item, ["manifest", "bytes", "digest"]); const bytes = artifact === undefined ? undefined : dataArray(artifact.bytes);
    if (artifact === undefined || bytes === undefined || !bytes.every((byte) => Number.isInteger(byte) && (byte as number) >= 0 && (byte as number) <= 255) || !binding(artifact.digest)) return undefined;
    try {
      const byBytes = parseCapabilityManifest(bytes as readonly number[]); const byValue = parseCapabilityManifest(serializeCapabilityManifest(artifact.manifest as CapabilityManifest));
      if (artifact.digest !== byBytes.manifest_digest || !equalBytes(bytes as readonly number[], serializeCapabilityManifest(byBytes)) || !equalBytes(serializeCapabilityManifest(byValue), serializeCapabilityManifest(byBytes))) return undefined;
      output.push(Object.freeze({ manifest: cloneManifest(byBytes), bytes: Object.freeze([...bytes] as number[]), digest: byBytes.manifest_digest }));
    } catch { return undefined; }
  }
  return Object.freeze(output);
};
const compose = (input: unknown): { readonly dependencies: Dependencies; readonly composition: Composition } => {
  const source = dataObject(input, WORLD_RUNTIME_INPUT_FIELDS);
  if (source === undefined || readParsedWorldSurfaceRegistry(source.surfaceRegistry) === undefined) return invalidComposition();
  const dynamics = readCheckedDynamicsSession(source.dynamics); const decisionRegistry = readDecisionRegistry(source.decisionRegistry); const readLedger = readWorldReadLedger(source.readLedger);
  const artifacts = checkedArtifacts(source.capabilityManifests); const grants = readBoundWorldGrants(source.boundGrants);
  if (dynamics === undefined || decisionRegistry === undefined || readLedger === undefined || artifacts === undefined || grants === undefined) return invalidComposition();
  const first = artifacts[0]!.manifest;
  let expected: readonly CapabilityManifestArtifact[];
  try { expected = compileCapabilityManifests({ runId: first.run_id, worldInstanceId: first.world.instance_id, world: { id: first.world.id as never }, surfaceRegistry: source.surfaceRegistry as WorldSurfaceRegistry, grants: grants as BoundWorldGrant[] }); } catch { return invalidComposition(); }
  if (expected.length !== artifacts.length || expected.some((item, index) => !equalBytes(item.bytes, artifacts[index]!.bytes))) return invalidComposition();
  try {
    const snapshot = dataObject(decisionRegistry.snapshot(), ["version", "runId", "worldInstanceId", "tokenDigestKeyFingerprint", "phase", "cutoffTick", "admissionsClosedTick", "finalizedTick", "lastTick", "nextDecisionSequence", "decisions"]);
    if (snapshot === undefined || snapshot.runId !== first.run_id || snapshot.worldInstanceId !== first.world.instance_id) return invalidComposition();
  } catch { return invalidComposition(); }
  if (!binding(first.run_id) || !binding(first.world.id) || !binding(first.world.instance_id)
    || artifacts.some((artifact) => !binding(artifact.manifest.holder.principal) || artifact.manifest.run_id !== first.run_id
      || artifact.manifest.world.id !== first.world.id || artifact.manifest.world.instance_id !== first.world.instance_id)) return invalidComposition();
  const manifests = new Map(artifacts.map((artifact) => [artifact.manifest.holder.principal, cloneManifest(artifact.manifest)]));
  if (manifests.size !== artifacts.length) return invalidComposition();
  return { dependencies: Object.freeze({ dynamics, surfaceRegistry: source.surfaceRegistry as WorldSurfaceRegistry, capabilityManifests: artifacts, decisionRegistry, readLedger, ledgerHandle: source.readLedger as WorldReadLedger }), composition: Object.freeze({ runId: first.run_id, worldId: first.world.id, worldInstanceId: first.world.instance_id, manifests }) };
};

const copyLedgerPage = (value: unknown, principal: string, request: ReturnType<typeof parseWorldReadLedgerRequest>, currentRunId: string, currentWorldId: string, currentWorldInstanceId: string, currentManifestDigest: string): WorldReadLedgerPage | undefined => {
  const page = dataObject(value, ["records", "next_after"]); const values = page === undefined ? undefined : dataArray(page.records);
  if (page === undefined || values === undefined || !safeInteger(page.next_after)) return undefined;
  const allowed = request.operations === undefined ? undefined : new Set(request.operations); let previous = request.after; const records: WorldReadLedgerRecord[] = [];
  for (const value of values) {
    const source = dataObject(value, ["sequence", "operation", "principal", "decision_id", "state_version", "result", "identity"], false);
    if (source === undefined || !safeInteger(source.sequence, 1)) return undefined;
    const record = parseWorldReadLedgerRecord({
      operation: source.operation, principal: source.principal, decision_id: source.decision_id,
      state_version: source.state_version, result: source.result, identity: source.identity,
    });
    if (record === undefined || record.principal !== principal || (record.result === "allowed" && (record.identity!.run_id !== currentRunId || record.identity!.world_id !== currentWorldId || record.identity!.world_instance_id !== currentWorldInstanceId || record.identity!.manifest_digest !== currentManifestDigest)) || source.sequence <= previous || source.sequence <= request.after || (allowed !== undefined && !allowed.has(record.operation))) return undefined;
    previous = source.sequence;
    records.push(Object.freeze({ ...record, sequence: source.sequence }));
  }
  if (records.length > request.limit || page.next_after !== (records.at(-1)?.sequence ?? request.after)) return undefined;
  return Object.freeze({ records: Object.freeze(records), next_after: page.next_after });
};

const resultRequest = (value: unknown): boolean => {
  const source = dataObject(value, ["version", "limit", "result_after"], false);
  return source?.version === "simfile.world-action-result-page-request.v1";
};
const buildWorldRuntime = (dependencies: Dependencies, composition: Composition,
  checkpointInput: { readonly checkpoint: unknown } | undefined, ownerLease: WorldRuntimeOwnerLease): WorldRuntime => {
  const available = ownerLease.available;
  const consume = ownerLease.consume;
  let restored: ReturnType<typeof restoreWorldRuntimeCheckpoint> | undefined;
  if (checkpointInput !== undefined) {
    try {
      restored = restoreWorldRuntimeCheckpoint({
        checkpoint: checkpointInput.checkpoint,
        dynamics: dependencies.dynamics,
        capabilityManifests: dependencies.capabilityManifests,
        decisionRegistry: dependencies.decisionRegistry,
        readLedger: dependencies.ledgerHandle,
        available,
        consume,
      });
    } catch { return invalidComposition(); }
  } else if (!available()) return invalidComposition();
  const stores = restored ?? createWorldRuntimePrivateStores();
  const resultLedger = stores.actionResultLedger;
  const resultAuthority = readWorldActionResultLedger(resultLedger);
  if (resultAuthority === undefined) return invalidComposition();
  if (restored === undefined) try {
    resultAuthority.reserve({ bindings: [...composition.manifests.values()].map((manifest) => ({
      principal: manifest.holder.principal, actor: manifest.holder.entity, run_id: manifest.run_id,
      world_id: manifest.world.id, world_instance_id: manifest.world.instance_id, manifest_digest: manifest.manifest_digest,
    })) });
  } catch { return invalidComposition(); }
  if (restored === undefined) try {
    dependencies.readLedger.reservePrincipals(Object.freeze([...composition.manifests.keys()]));
  } catch {
    return invalidComposition();
  }
  const actionJournal = stores.actionJournal;
  if (restored === undefined) try { actionJournal.reservePrincipals(Object.freeze([...composition.manifests.keys()])); } catch { return invalidComposition(); }
  const actionRefusals = createWorldActionRefusalJournal({ principals: [...composition.manifests.keys()], readTick: () => dependencies.dynamics.nextTick });
  const requestLedger = stores.requestLedger;
  const ledgerHandle = dependencies.ledgerHandle;
  if (restored === undefined) consume();
  let operating = false;
  let reentered = false;
  let mechanicsClosed = restored?.mechanicsClosed ?? false;
  let checkpointing = false;
  const operation = Object.freeze({
    enter: (): void => {
      if (mechanicsClosed) throw new Error("world mechanics closed");
      if (operating) { reentered = true; throw new Error("world runtime reentry"); }
      operating = true; reentered = false;
    },
    leave: (): void => { operating = false; reentered = false; },
    reentered: (): boolean => reentered,
    close: (): void => { mechanicsClosed = true; requestLedger.close(); actionJournal.close(); },
  });
  const checkpointOperation = Object.freeze({
    enter: (): void => {
      if (checkpointing) { reentered = true; throw new Error("world checkpoint reentry"); }
      if (operating) throw new Error("world runtime is not stable");
      operating = true; reentered = false; checkpointing = true;
    },
    leave: (): void => { checkpointing = false; operating = false; reentered = false; },
    stable: (): boolean => checkpointing && operating && !reentered,
  });
  const claimAuthority = createWorldDecisionClaimAuthority({ decisionRegistry: dependencies.decisionRegistry,
    principals: new Set(composition.manifests.keys()), readTick: () => dependencies.dynamics.nextTick });
  const call = <Result>(operation: WorldReadOperation, context: unknown, request: unknown, build: (manifest: CapabilityManifest, admission: DecisionReadAdmission, identity: WorldRuntimeIdentity) => Result): Result => {
    if (operating) {
      reentered = true;
      const reentrant = safeContext(context);
      if (!checkpointing && reentrant.principal !== undefined && composition.manifests.has(reentrant.principal)) {
        try { dependencies.readLedger.append(Object.freeze({ operation, principal: reentrant.principal, result: "denied" })); } catch { /* The generic denial remains authoritative. */ }
      }
      return denied();
    }
    operating = true;
    let auditAttempted = false;
    const checked = safeContext(context);
    const audit = (record: Omit<Parameters<WorldReadLedgerAuthority["append"]>[0], "principal">): boolean => {
      if (auditAttempted || checked.principal === undefined) return false;
      auditAttempted = true;
      try { dependencies.readLedger.append(Object.freeze({ ...record, principal: checked.principal })); return true; } catch { return false; }
    };
    const reject = (): never => { if (checked.principal !== undefined) audit({ operation, result: "denied" }); return denied(); };
    try {
      if (checked.principal === undefined || checked.token === undefined) return reject();
      const manifest = composition.manifests.get(checked.principal); if (manifest === undefined) return reject();
      let atTick: number; let admission: DecisionReadAdmission;
      try {
        atTick = dependencies.dynamics.nextTick;
        if (!safeInteger(atTick)) return reject();
        admission = dependencies.decisionRegistry.peekReadAdmission({ principal: checked.principal, runId: composition.runId, worldInstanceId: composition.worldInstanceId, token: checked.token, atTick });
      } catch { return reject(); }
      const identity = freezeIdentity(manifest, atTick);
      let result: Result;
      try { result = build(manifest, admission, identity); } catch { return reject(); }
      if (!audit({ operation, decision_id: admission.decisionId, state_version: atTick, result: "allowed", identity })) return denied();
      return result;
    } finally { operating = false; }
  };
  const runtime = Object.freeze({
    status: (context: AuthenticatedWorldContext) => call("status", context, undefined, (manifest, admission, identity) => Object.freeze({ identity, orientation: Object.freeze({ holder_entity: manifest.holder.entity }), decision: Object.freeze({ id: admission.decisionId, phase: admission.phase, issued_at_tick: admission.issuedTick, valid_through_tick: admission.validThroughTick }) })),
    capabilities: (context: AuthenticatedWorldContext) => call("capabilities", context, undefined, (manifest, _admission, identity) => Object.freeze({ identity, manifest: cloneManifest(manifest) })),
    observe: (context: AuthenticatedWorldContext, request: unknown) => call("observe", context, request, (manifest, _admission, identity) =>
      observeWorldRuntime({ dynamics: dependencies.dynamics, surfaceRegistry: dependencies.surfaceRegistry }, manifest, identity, request)),
    affordances: (context: AuthenticatedWorldContext) => call("affordances", context, undefined, (manifest, _admission, identity) =>
      affordancesWorldRuntime({ dynamics: dependencies.dynamics, surfaceRegistry: dependencies.surfaceRegistry }, manifest, identity)),
    ledger: (context: AuthenticatedWorldContext, request?: unknown) => {
      if (resultRequest(request)) {
        if (operating) { reentered = true; return denied(); }
        operating = true;
        try {
          const checked = safeContext(context); const manifest = checked.principal === undefined ? undefined : composition.manifests.get(checked.principal);
          const parsed = parseWorldActionResultPageRequest(request);
          if (checked.principal === undefined || checked.token === undefined || manifest === undefined || parsed === undefined) return denied();
          const atTick = dependencies.dynamics.nextTick;
          if (!safeInteger(atTick)) return denied();
          const identity = freezeIdentity(manifest, atTick);
          const issuer = createDecisionResultReadAdmission({ registry: dependencies.decisionRegistry, manifest, runtimeAuthority: identity });
          const admission = issuer.admit({ principal: checked.principal, runId: composition.runId, worldInstanceId: composition.worldInstanceId, token: checked.token, atTick, manifest, runtimeAuthority: identity });
          const metadata = issuer.read(admission);
          if (metadata.principal !== checked.principal || metadata.runId !== composition.runId || metadata.worldInstanceId !== composition.worldInstanceId || metadata.atTick !== atTick || metadata.manifestDigest !== identity.manifest_digest) return denied();
          const page = resultLedger.read(checked.principal, parsed);
          return Object.freeze({ identity, results: page.results, ...(page.next_result_after === undefined ? {} : { next_result_after: page.next_result_after }) });
        } catch { return denied(); }
        finally { operating = false; }
      }
      return call("ledger", context, request, (_manifest, _admission, identity) => {
      const checked = safeContext(context); const parsed = parseWorldReadLedgerRequest(request); const page = copyLedgerPage(dependencies.readLedger.read(checked.principal!, request), checked.principal!, parsed, composition.runId, composition.worldId, composition.worldInstanceId, identity.manifest_digest);
      if (page === undefined) return denied();
      return Object.freeze({ identity, records: page.records, next_after: page.next_after });
      });
    },
    act: (context: AuthenticatedWorldContext, envelope: Uint8Array): WorldActIngressReceipt => {
      const checked = safeContext(context);
      if (operating) {
        reentered = true;
        if (!checkpointing && checked.principal !== undefined && composition.manifests.has(checked.principal)) {
          try {
            const audit = actionJournal.reserveAudit(checked.principal);
            audit.commit("denied");
            if (audit.terminal_capacity) operation.close();
          } catch { operation.close(); }
        }
        return actionRefusals.refuse(checked.principal, "ingress_reentered");
      }
      if (checked.principal === undefined || !composition.manifests.has(checked.principal)) return actionRefusals.refuse(checked.principal, "principal_unknown");
      if (mechanicsClosed) {
        try {
          const claim = requestLedger.beginClaim({
            bytes: envelope,
            authority: {
              principal: checked.principal,
              run_id: composition.runId,
              world_id: composition.worldId,
              world_instance_id: composition.worldInstanceId,
            },
          });
          if (claim.kind === "replay") return claim.receipt;
        } catch { /* closed ingress remains denied */ }
        return actionRefusals.refuse(checked.principal, "ingress_closed");
      }
      operating = true; reentered = false;
      try {
        return actWorldRuntime({ dynamics: dependencies.dynamics, surfaceRegistry: dependencies.surfaceRegistry, decisionRegistry: dependencies.decisionRegistry, journal: actionJournal, requestLedger, runId: composition.runId, worldId: composition.worldId, worldInstanceId: composition.worldInstanceId, closeMechanics: operation.close, refuse: (reason, fieldPath) => actionRefusals.refuse(checked.principal, reason, fieldPath) }, composition.manifests.get(checked.principal)!, checked.principal, checked.token ?? "", envelope, () => reentered);
      } finally { operating = false; reentered = false; }
    },
  });
  registerWorldRuntimeActionJournalInspection(runtime, actionJournal);
  registerWorldRuntimeActionRefusalJournalInspection(runtime, actionRefusals);
  registerWorldRuntimeRequestLedgerInspection(runtime, requestLedger);
  const controller = createWorldRuntimeControllerAuthority(runtime, { dynamics: dependencies.dynamics, operation });
  createWorldRuntimeClockAuthority(runtime, { controller, dynamics: dependencies.dynamics,
    surfaceRegistry: dependencies.surfaceRegistry, journal: actionJournal, operation });
  registerWorldRuntimeActionResultLedgerInspection(runtime, resultLedger);
  registerWorldRuntimeCheckpointCoordinator(runtime, {
    dynamics: dependencies.dynamics,
    capabilityManifests: dependencies.capabilityManifests,
    decisionRegistry: dependencies.decisionRegistry,
    actionJournal,
    requestLedger,
    actionResultLedger: resultLedger,
    readLedger: ledgerHandle,
    operation: checkpointOperation,
  });
  registerWorldDecisionClaimAuthority(runtime, claimAuthority);
  if (restored !== undefined) {
    try {
      const recaptured = readWorldRuntimeCheckpointCoordinator(runtime)?.capture();
      if (recaptured === undefined || !isDeepStrictEqual(recaptured, restored.checkpoint)) return invalidComposition();
    } catch { return invalidComposition(); }
  }
  return runtime as WorldRuntime;
};

const issueWorldRuntime = (input: unknown, checkpointInput?: { readonly checkpoint: unknown }): WorldRuntime => {
  const { dependencies, composition } = compose(input);
  const ownerLease = stageWorldRuntimeOwners(dependencies);
  try { return buildWorldRuntime(dependencies, composition, checkpointInput, ownerLease); }
  finally { ownerLease.release(); }
};

export const createWorldRuntime = (input: unknown): WorldRuntime => issueWorldRuntime(input);

/** @internal Deep-only host restoration seam; deliberately absent from public barrels. */
export const createRestoredWorldRuntime = (
  input: CreateWorldRuntimeInput,
  checkpointInput: unknown,
): WorldRuntime => issueWorldRuntime(input, { checkpoint: checkpointInput });
