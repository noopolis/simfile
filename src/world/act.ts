import type { DynamicsSession } from "../dynamics/session.js";
import { isDynamicsRetainedActionCapacityError } from "../dynamics/retainedCapacity.js";
import { sameDynamicsSessionSnapshot } from "../dynamics/sameDynamicsSessionSnapshot.js";
import type { ReadonlyDynamicsJsonObject } from "../dynamics/types.js";
import {
  isWorldActIngressRejectionFieldPath,
  isWorldActIngressRejectionReason,
  readWorldSurfaceRejection,
  type WorldActIngressRejectionReason,
  type WorldSurfaceRegistry,
} from "../world-surface/index.js";
import { parseWorldSurfaceObservation } from "../world-surface/observation.js";
import { resolveWorldAddress, type CanonicalWorldAddress, type LocalResourceReference } from "./addresses.js";
import type { ActionAuditReservation, ActionJournalReservation, WorldActionJournal } from "./actionJournal.js";
import type { WorldActIngressReceipt, WorldActIngressRejection, WorldActQueuedReceipt } from "./actTypes.js";
import type { ParsedWorldActEnvelope } from "./actEnvelope.js";
import type { CapabilityManifest } from "./capabilityManifest.js";
import {
  readDecisionRegistryErrorCode,
  reserveDecisionForAct,
  type DecisionActReservation,
  type DecisionRegistry,
} from "./decisionRegistry.js";
import { isCanonicalDecisionToken } from "./decisionRegistryInput.js";
import { observeScopedWorldRuntime } from "./observe.js";
import type { WorldRuntimeIdentity } from "./runtime.js";
import type { WorldRequestLedger, WorldRequestReservation } from "./requestLedger.js";

type Dependencies = Readonly<{
  dynamics: DynamicsSession;
  surfaceRegistry: WorldSurfaceRegistry;
  decisionRegistry: DecisionRegistry;
  journal: WorldActionJournal;
  requestLedger: WorldRequestLedger;
  runId: string;
  worldId: string;
  worldInstanceId: string;
  closeMechanics: () => void;
  refuse: (
    reason: WorldActIngressRejectionReason,
    fieldPath?: string,
  ) => WorldActIngressRejection;
}>;
type Checked = Readonly<{ affordance: CanonicalWorldAddress; target: CanonicalWorldAddress; input: unknown }>;
const local = (worldId: string, address: LocalResourceReference): CanonicalWorldAddress => resolveWorldAddress({ id: worldId as never }, address);
const unmutated = (dynamics: DynamicsSession, snapshot: ReturnType<DynamicsSession["snapshot"]>, tick: number): boolean => {
  try { if (dynamics.nextTick === tick && sameDynamicsSessionSnapshot(dynamics.snapshot(), snapshot)) return true; } catch { /* restore below */ }
  try { dynamics.restore(snapshot); } catch { /* caller denies */ }
  return false;
};

/** @internal the only constructor for agent-visible ingress rejections. */
export const denyWith = (reason: unknown, fieldPath?: unknown): WorldActIngressRejection => {
  if (!isWorldActIngressRejectionReason(reason)
    || (fieldPath !== undefined && !isWorldActIngressRejectionFieldPath(fieldPath))) {
    return Object.freeze({
      disposition: "rejected_at_ingress",
      code: "world_action_denied",
      reason: "internal_error",
    });
  }
  return Object.freeze({
    disposition: "rejected_at_ingress",
    code: "world_action_denied",
    reason,
    ...(fieldPath === undefined ? {} : { field_path: fieldPath }),
  });
};

const abortReservations = (
  dependencies: Dependencies,
  request: WorldRequestReservation | undefined,
  decision: DecisionActReservation | undefined,
  cell: ActionJournalReservation | undefined,
  pre: ReturnType<DynamicsSession["snapshot"]> | undefined,
): void => {
  try { request?.abort(); } catch { /* already settled or capacity-closed */ }
  try { decision?.abort(); } catch { /* already settled */ }
  try { cell?.abort(); } catch { /* already settled */ }
  if (pre !== undefined) try { dependencies.dynamics.restore(pre); } catch { /* caller denies */ }
};

/** @internal synchronous B23 ingress; runtime owns the gate and context parsing. */
export const actWorldRuntime = (
  dependencies: Dependencies,
  manifest: CapabilityManifest,
  principal: string,
  token: string,
  envelopeBytes: Uint8Array,
  stickyReentry: () => boolean,
): WorldActIngressReceipt => {
  let audit: ActionAuditReservation | undefined;
  let decision: DecisionActReservation | undefined;
  let cell: ActionJournalReservation | undefined;
  let request: WorldRequestReservation | undefined;
  let pre: ReturnType<DynamicsSession["snapshot"]> | undefined;
  let queuedAuditCommitted = false;
  let terminalAuditCapacity = false;
  let surfaceFailure: { readonly error: unknown } | undefined;
  const callSurface = <Result>(call: () => Result): Result => {
    try { return call(); } catch (error) {
      surfaceFailure = { error };
      throw error;
    }
  };
  const deny = (
    reason: WorldActIngressRejectionReason,
    fieldPath?: string,
    close = false,
  ): WorldActIngressReceipt => {
    const terminal = close || terminalAuditCapacity || audit?.terminal_capacity === true || dependencies.requestLedger.closed;
    abortReservations(dependencies, request, decision, cell, pre);
    try { audit?.commit("denied"); } catch { close = true; }
    audit = undefined;
    if (terminal || close) {
      try { dependencies.requestLedger.close(); } catch { /* denial remains authoritative */ }
      try { dependencies.closeMechanics(); } catch { /* denial remains authoritative */ }
    }
    return dependencies.refuse(reason, fieldPath);
  };
  try {
    const authority = Object.freeze({
      principal,
      run_id: dependencies.runId,
      world_id: dependencies.worldId,
      world_instance_id: dependencies.worldInstanceId,
    });
    const claim = dependencies.requestLedger.beginClaim({ bytes: envelopeBytes, authority });
    if (claim.kind === "replay") return claim.receipt;
    if (claim.kind === "malformed") {
      try { audit = dependencies.journal.reserveAudit(principal); } catch { return deny("capacity_exhausted", undefined, true); }
      terminalAuditCapacity = audit.terminal_capacity;
      return deny(terminalAuditCapacity ? "capacity_exhausted" : "request_malformed");
    }
    if (claim.kind === "conflict") {
      try { audit = dependencies.journal.reserveAudit(principal); } catch { return deny("capacity_exhausted", undefined, true); }
      terminalAuditCapacity = audit.terminal_capacity;
      return deny(terminalAuditCapacity ? "capacity_exhausted" : "request_conflict");
    }
    const envelope: ParsedWorldActEnvelope = claim.envelope;
    request = claim.reservation;
    try { audit = dependencies.journal.reserveAudit(principal); } catch { return deny("capacity_exhausted", undefined, true); }
    terminalAuditCapacity = audit.terminal_capacity;
    if (terminalAuditCapacity) return deny("capacity_exhausted");
    const atTick = dependencies.dynamics.nextTick;
    if (!Number.isSafeInteger(atTick)) return deny("world_state_unstable");
    if (stickyReentry()) return deny("ingress_reentered");
    if (!isCanonicalDecisionToken(token)) return deny("decision_token_invalid");
    try {
      decision = reserveDecisionForAct(dependencies.decisionRegistry, {
        principal, runId: dependencies.runId, worldInstanceId: dependencies.worldInstanceId, token, atTick,
      });
    } catch (error) {
      const code = readDecisionRegistryErrorCode(error);
      if (code === "token_consumed") return deny("decision_token_consumed");
      if (code === "token_expired") return deny("decision_token_expired");
      if (code === "token_invalid") return deny("decision_token_invalid");
      throw error;
    }
    const requestValue: Checked = Object.freeze({
      affordance: envelope.affordance as CanonicalWorldAddress,
      target: envelope.target as CanonicalWorldAddress,
      input: envelope.input,
    });
    const granted = manifest.affordances.find((entry) => entry.address === requestValue.affordance);
    if (granted === undefined) return deny("affordance_not_granted");
    const targetAllowed = granted.target_selector.kind === "holder"
      ? requestValue.target === manifest.holder.entity
      : granted.target_selector.targets.includes(requestValue.target);
    if (!targetAllowed) return deny("target_not_granted");
    const affordance = dependencies.surfaceRegistry.affordances.find((entry) => local(manifest.world.id, entry.address) === requestValue.affordance);
    const holder = dependencies.surfaceRegistry.entities.find((entry) => local(manifest.world.id, entry.address) === manifest.holder.entity);
    const target = dependencies.surfaceRegistry.entities.find((entry) => local(manifest.world.id, entry.address) === requestValue.target);
    if (affordance === undefined || holder === undefined || target === undefined) return deny("resource_undeclared");
    pre = dependencies.dynamics.snapshot();
    const identity: WorldRuntimeIdentity = Object.freeze({
      run_id: manifest.run_id, world_id: manifest.world.id, world_instance_id: manifest.world.instance_id,
      manifest_digest: manifest.manifest_digest, state_version: atTick,
    });
    const observation = callSurface(() => {
      const channels = manifest.senses.map((sense) => observeScopedWorldRuntime(dependencies, manifest, identity, sense.address).observation.channels).flat();
      return parseWorldSurfaceObservation({ channels }, "aggregate action observation");
    });
    if (!unmutated(dependencies.dynamics, pre, atTick)) return deny("world_state_unstable");
    if (stickyReentry()) return deny("ingress_reentered");
    const available = callSurface(() => dependencies.surfaceRegistry.isAffordanceAvailable(
      affordance.address,
      Object.freeze({ holder: holder.address, observation, target: target.address }),
    ));
    if (available !== true) return deny("affordance_unavailable");
    if (!unmutated(dependencies.dynamics, pre, atTick)) return deny("world_state_unstable");
    if (stickyReentry()) return deny("ingress_reentered");
    const lowered = callSurface(() => dependencies.surfaceRegistry.lowerAffordance(affordance.address, Object.freeze({
      holder: holder.address, target: target.address, observation, input: requestValue.input as ReadonlyDynamicsJsonObject,
    })));
    if (!unmutated(dependencies.dynamics, pre, atTick)) return deny("world_state_unstable");
    if (stickyReentry()) return deny("ingress_reentered");
    const expected = pre.next_action_sequence;
    if (!Number.isSafeInteger(expected) || expected < 1) return deny("internal_error");
    const receipt: WorldActQueuedReceipt = Object.freeze({
      disposition: "queued", receipt_id: `world-act-${expected}`, decision_id: decision.decisionId, identity, apply_tick: atTick,
    });
    cell = dependencies.journal.reserve(receipt, expected);
    const queue = dependencies.dynamics.queueAction({
      act_id: receipt.receipt_id, action: affordance.dynamics_action, actor: holder.dynamics_address,
      at_tick: atTick, input: lowered, origin: "agentic", principal_id: principal, target: target.dynamics_address,
    });
    if (!queue.queued) return deny("internal_error");
    if (queue.act_id !== receipt.receipt_id) return deny("internal_error");
    if (queue.apply_tick !== atTick) return deny("internal_error");
    if (queue.sequence !== expected) return deny("internal_error");
    if (stickyReentry()) return deny("ingress_reentered");
    const queued = Object.freeze({
      receipt_id: receipt.receipt_id, decision_id: receipt.decision_id, principal,
      holder: manifest.holder.entity, affordance: requestValue.affordance, target: requestValue.target,
      at_tick: atTick, dynamics_sequence: expected, mechanics_action: affordance.dynamics_action,
      mechanics_actor: holder.dynamics_address, mechanics_target: target.dynamics_address,
      lowered_input: lowered, identity,
    });
    cell.persist(queued);
    cell.prepareAuthorization();
    request.prepare({ at_tick: atTick, queued_action: queued, receipt });
    audit.commit("queued");
    audit = undefined;
    queuedAuditCommitted = true;
    request.commit(); request = undefined;
    decision.commit(); decision = undefined;
    cell.authorize(); cell = undefined;
    return receipt;
  } catch (error) {
    if (audit === undefined && !queuedAuditCommitted) {
      try { audit = dependencies.journal.reserveAudit(principal); } catch { /* the journal may have closed with the failure */ }
    }
    const bounded = readWorldSurfaceRejection(error);
    const capacity = terminalAuditCapacity || dependencies.requestLedger.closed
      || isDynamicsRetainedActionCapacityError(error);
    // Only calls made through callSurface are known to originate in surface
    // orchestration; other unstructured throws are host-internal failures.
    const reason = capacity ? "capacity_exhausted"
      : bounded?.reason ?? (surfaceFailure?.error === error ? "world_surface_failed" : "internal_error");
    return deny(reason, bounded?.fieldPath, capacity);
  }
};
