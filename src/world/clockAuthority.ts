import { isDynamicsRetryableStepFailure } from "../dynamics/session.js";
import type { DynamicsSession } from "../dynamics/session.js";
import type { DynamicsStepResult } from "../dynamics/types.js";
import { DYNAMICS_LIMITS } from "../dynamics/limits.js";
import type { WorldSurfaceRegistry } from "../world-surface/index.js";
import type { WorldActionJournal } from "./actionJournal.js";
import { readWorldActionResultLedger } from "./actionResultLedger.js";
import { readWorldRuntimeActionResultLedgerInspection } from "./actionResultLedgerInspection.js";
import { resolveWorldActionStep } from "./actionResults.js";
import type { WorldRuntimeControllerAuthority } from "./controllerAuthority.js";

export interface WorldDynamicsTickRecord {
  readonly tick: number;
  readonly action_results: number;
  readonly events: number;
  /** Host-only unfiltered mechanics result retained for run recording. */
  readonly raw_step: DynamicsStepResult;
}
export interface WorldRuntimeClockAuthority { stepDynamics(): WorldDynamicsTickRecord; }
const issued = new WeakSet<object>();
const clocks = new WeakMap<object, WorldRuntimeClockAuthority>();
export const readWorldRuntimeClockAuthority = (runtime: unknown): WorldRuntimeClockAuthority | undefined =>
  runtime !== null && typeof runtime === "object" ? clocks.get(runtime) : undefined;
export const createWorldRuntimeClockAuthority = (runtime: object, dependencies: Readonly<{
  dynamics: DynamicsSession; surfaceRegistry: WorldSurfaceRegistry; journal: WorldActionJournal;
  operation: { enter(): void; leave(): void; reentered(): boolean; close(): void };
  controller?: WorldRuntimeControllerAuthority;
}>): void => {
  if (clocks.has(runtime)) throw new Error("world clock already issued");
  const clock: WorldRuntimeClockAuthority = Object.freeze({ stepDynamics: () => {
    dependencies.operation.enter();
    let reservation: ReturnType<WorldActionJournal["reserveTerminals"]> | undefined;
    let resultReservation: Parameters<typeof resolveWorldActionStep>[0]["resultReservation"];
    let resultLedger: ReturnType<typeof readWorldActionResultLedger>;
    let resultMode = false;
    let stepStarted = false;
    let stepCompleted = false;
    let terminalsSettled = false;
    try {
      const publicLedger = readWorldRuntimeActionResultLedgerInspection(runtime);
      resultMode = publicLedger !== undefined;
      resultLedger = publicLedger === undefined ? undefined : readWorldActionResultLedger(publicLedger);
      if (resultMode && resultLedger === undefined) throw new Error("world action result ledger inspection is unavailable");
      reservation = dependencies.journal.reserveTerminals(dependencies.dynamics.nextTick);
      if (resultLedger !== undefined && reservation.queued.length > 0) {
        const actions = reservation.queued.map((action) => {
          const local = action.affordance.split("/");
          const affordance = local.length >= 2 && local.at(-2) === "affordance"
            ? dependencies.surfaceRegistry.affordances.find((entry) => entry.address === `affordance:${local.at(-1)!}`)
            : undefined;
          if (affordance === undefined) throw new Error("invalid queued affordance");
          return { principal: action.principal, receipt_id: action.receipt_id, decision_id: action.decision_id,
            action_sequence: action.dynamics_sequence, declared_rejection_codes: affordance.rejection_codes };
        });
        resultReservation = resultLedger.reserveBatch({ actions, effect_capacity: DYNAMICS_LIMITS.events_per_tick });
      }
      let rawStep: DynamicsStepResult;
      try { stepStarted = true; rawStep = dependencies.dynamics.step(); stepCompleted = true; }
      catch (error) { reservation.abort(); terminalsSettled = true; throw error; }
      const step = dependencies.controller?.settle(rawStep) ?? rawStep;
      resolveWorldActionStep({ dynamics: dependencies.dynamics, surfaceRegistry: dependencies.surfaceRegistry, journal: dependencies.journal,
        reservation, step, reentered: dependencies.operation.reentered, closeMechanics: dependencies.operation.close,
        ...(resultReservation === undefined ? {} : { resultReservation, postMechanicsStateVersion: dependencies.dynamics.nextTick }) });
      terminalsSettled = true;
      const record = { tick: rawStep.tick, action_results: rawStep.action_results.length, events: rawStep.events.length } as WorldDynamicsTickRecord;
      Object.defineProperty(record, "raw_step", { enumerable: false, value: rawStep });
      return Object.freeze(record);
    } catch (error) {
      if (resultLedger?.hasLiveReservation() === true) resultReservation?.abort();
      if (!stepStarted && reservation !== undefined && !terminalsSettled) { reservation.abort(); terminalsSettled = true; }
      if (resultMode && (!stepStarted || stepCompleted || !isDynamicsRetryableStepFailure(error))) dependencies.operation.close();
      throw error;
    } finally { dependencies.operation.leave(); }
  }});
  issued.add(clock); clocks.set(runtime, clock);
};
export const isWorldRuntimeClockAuthority = (value: unknown): value is WorldRuntimeClockAuthority => value !== null && typeof value === "object" && issued.has(value);
