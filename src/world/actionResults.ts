import type { DynamicsSession } from "../dynamics/session.js";
import { sameDynamicsSessionSnapshot } from "../dynamics/sameDynamicsSessionSnapshot.js";
import type { DynamicsActionResult, DynamicsStepResult } from "../dynamics/types.js";
import type { WorldSurfaceRegistry } from "../world-surface/index.js";
import type { WorldActionJournal, WorldActionTerminalReservation } from "./actionJournal.js";
import { parseWorldActionTerminal } from "./actionJournalSnapshot.js";
import type { QueuedWorldAction, WorldActionTerminal, WorldActQueuedReceipt } from "./actTypes.js";
import { prepareWorldActionResults, type WorldActionResultProjectionReservation } from "./actionResultProjection.js";

const localAffordance = (address: string): string => {
  const parts = address.split("/");
  if (parts.length < 2 || parts.at(-2) !== "affordance") throw new Error("invalid queued affordance");
  return `affordance:${parts.at(-1)!}`;
};
const terminal = (action: QueuedWorldAction, result: DynamicsActionResult, code?: string): WorldActionTerminal => Object.freeze({
  disposition: result.accepted ? "applied" : "rejected_at_mechanics", receipt_id: action.receipt_id, decision_id: action.decision_id,
  sequence: action.dynamics_sequence, apply_tick: action.at_tick, projection: "not_configured",
  ...(result.accepted ? {} : { public_code: code }),
});
const queuedReceipt = (action: QueuedWorldAction): WorldActQueuedReceipt => Object.freeze({
  disposition: "queued", receipt_id: action.receipt_id, decision_id: action.decision_id,
  identity: action.identity, apply_tick: action.at_tick,
});
const exact = (action: QueuedWorldAction, result: DynamicsActionResult): boolean =>
  result.sequence === action.dynamics_sequence && result.act_id === action.receipt_id && result.action === action.mechanics_action
  && result.actor === action.mechanics_actor && result.principal_id === action.principal && result.target === action.mechanics_target
  && result.apply_tick === action.at_tick;
const publicRejectionCode = (action: QueuedWorldAction, result: DynamicsActionResult, registry: WorldSurfaceRegistry): string => {
  const local = localAffordance(action.affordance);
  const declared = registry.affordances.find((entry) => entry.address === local);
  return typeof result.code === "string" && declared?.rejection_codes.includes(result.code) ? result.code : "world_action_rejected";
};
const failProjection = (journal: WorldActionJournal, fact: WorldActionTerminal): void => {
  journal.project(Object.freeze({ ...fact, projection: "failed" }));
};
const closeJoin = (journal: WorldActionJournal, message: string, resultReservation?: WorldActionResultProjectionReservation): never => {
  let settlementError: unknown;
  try { resultReservation?.abort(); } catch (error) { settlementError = error; }
  finally { journal.close(); }
  if (settlementError !== undefined) throw settlementError;
  throw new Error(message);
};
const closeOperationally = (input: Readonly<{ journal: WorldActionJournal; closeMechanics: () => void }>, message: string): never => {
  input.journal.close();
  input.closeMechanics();
  throw new Error(message);
};

/** @internal joins one already-reserved host step result before invoking projections. */
export const resolveWorldActionStep = (input: Readonly<{
  dynamics: DynamicsSession; surfaceRegistry: WorldSurfaceRegistry; journal: WorldActionJournal;
  reservation: WorldActionTerminalReservation; step: DynamicsStepResult; reentered: () => boolean; closeMechanics: () => void;
  resultReservation?: WorldActionResultProjectionReservation; postMechanicsStateVersion?: number;
}>): void => {
  const pending = input.reservation.queued;
  if ((input.resultReservation === undefined) !== (input.postMechanicsStateVersion === undefined)) {
    return closeJoin(input.journal, "world action result projection configuration", input.resultReservation);
  }
  if (!Array.isArray(input.step.action_results) || input.step.action_results.length !== pending.length) {
    return closeJoin(input.journal, "world action mechanics result mismatch", input.resultReservation);
  }
  const expected = new Map(pending.map((action) => [action.dynamics_sequence, action]));
  const bySequence = new Map<number, DynamicsActionResult>();
  for (const result of input.step.action_results) {
    if (result === null || typeof result !== "object" || !expected.has(result.sequence)) {
      return closeJoin(input.journal, "foreign world action mechanics result", input.resultReservation);
    }
    if (bySequence.has(result.sequence)) return closeJoin(input.journal, "duplicate world action mechanics result", input.resultReservation);
    const action = expected.get(result.sequence)!;
    if (!exact(action, result)) return closeJoin(input.journal, "world action mechanics result mismatch", input.resultReservation);
    bySequence.set(result.sequence, result);
  }
  const resolved: Array<Readonly<{ action: QueuedWorldAction; result: DynamicsActionResult }>> = [];
  const facts: WorldActionTerminal[] = [];
  for (const action of pending) {
    const result = bySequence.get(action.dynamics_sequence);
    if (result === undefined) return closeJoin(input.journal, "world action mechanics result mismatch", input.resultReservation);
    resolved.push({ action, result });
    facts.push(terminal(action, result, result.accepted ? undefined : publicRejectionCode(action, result, input.surfaceRegistry)));
  }
  input.reservation.commit(facts);
  if (input.resultReservation !== undefined && input.postMechanicsStateVersion !== undefined) {
    prepareWorldActionResults({ pending, terminals: facts, events: input.step.events, postMechanicsStateVersion: input.postMechanicsStateVersion, registry: input.surfaceRegistry, reservation: input.resultReservation });
  }
  if (facts.every((fact) => fact.disposition !== "applied")) return;
  let postStep: ReturnType<DynamicsSession["snapshot"]>;
  try { postStep = input.dynamics.snapshot(); }
  catch { return closeOperationally(input, "world action post-step snapshot failed"); }
  for (let index = 0; index < facts.length; index += 1) {
    const fact = facts[index]!;
    if (fact.disposition !== "applied") continue;
    if (input.reentered()) {
      try { failProjection(input.journal, fact); }
      catch { return closeOperationally(input, "world action projection failure could not be recorded"); }
      continue;
    }
    try {
      const effect = input.surfaceRegistry.projectAffordanceResult(localAffordance(resolved[index]!.action.affordance) as never, Object.freeze({ accepted: true }));
      if (input.reentered()
        || !sameDynamicsSessionSnapshot(postStep, input.dynamics.snapshot())) {
        throw new Error("world action projection failed");
      }
      const candidate = Object.freeze({ ...fact, projection: effect === undefined ? "not_configured" : "projected", ...(effect === undefined ? {} : { effect }) });
      if (parseWorldActionTerminal(candidate, queuedReceipt(resolved[index]!.action), fact.sequence) === undefined) {
        throw new Error("world action projection failed");
      }
      input.journal.project(candidate);
    } catch {
      try { input.dynamics.restore(postStep); }
      catch { return closeOperationally(input, "world action projection restore failed"); }
      try { failProjection(input.journal, fact); }
      catch { return closeOperationally(input, "world action projection failure could not be recorded"); }
    }
  }
};
