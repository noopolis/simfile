import type { DynamicsEvent } from "../dynamics/types.js";
import type { WorldSurfaceRegistry } from "../world-surface/index.js";
import type { QueuedWorldAction, WorldActionTerminal } from "./actTypes.js";
import { parseWorldActionResultIdentity, type WorldActionResult, type WorldActionResultIdentity } from "./actionResult.js";
import type { WorldActionResultBatchReservation } from "./actionResultLedger.js";

export type WorldActionResultProjectionReservation = WorldActionResultBatchReservation;

const frozen = <T>(value: T): T => Object.freeze(value);
const checkedEvent = (event: DynamicsEvent): boolean => event.provenance === "mechanical" && Number.isSafeInteger(event.event_sequence) && event.event_sequence >= 0 && Number.isSafeInteger(event.tick) && event.tick >= 0 && Array.isArray(event.cause_action_sequences) && event.cause_action_sequences.every((value) => Number.isSafeInteger(value) && value > 0);

/** @internal Builds public values only from an issued ledger batch reservation. */
export const prepareWorldActionResults = (input: Readonly<{
  readonly pending: readonly QueuedWorldAction[]; readonly terminals: readonly WorldActionTerminal[]; readonly events: readonly DynamicsEvent[];
  readonly postMechanicsStateVersion: number; readonly registry: WorldSurfaceRegistry; readonly reservation: WorldActionResultBatchReservation;
}>): readonly WorldActionResult[] => {
  try {
    if (!Number.isSafeInteger(input.postMechanicsStateVersion) || input.postMechanicsStateVersion < 0) throw new Error("invalid post-mechanics state version");
    if (input.pending.length !== input.terminals.length) throw new Error("world action result terminal mismatch");
    const current = new Map<number, WorldActionTerminal>(), accepted = new Set<number>(), identities: WorldActionResultIdentity[] = [];
    for (let index = 0; index < input.pending.length; index += 1) {
      const action = input.pending[index]!, terminal = input.terminals[index]!;
      const actionIdentity = parseWorldActionResultIdentity(action.identity);
      if (terminal.sequence !== action.dynamics_sequence || terminal.receipt_id !== action.receipt_id || terminal.decision_id !== action.decision_id
        || !Number.isSafeInteger(terminal.apply_tick) || terminal.apply_tick < 0 || terminal.apply_tick === Number.MAX_SAFE_INTEGER
        || terminal.apply_tick + 1 !== input.postMechanicsStateVersion || actionIdentity === undefined || current.has(action.dynamics_sequence)) {
        throw new Error("world action result terminal mismatch");
      }
      const identity = parseWorldActionResultIdentity({ run_id: actionIdentity.run_id, world_id: actionIdentity.world_id,
        world_instance_id: actionIdentity.world_instance_id, manifest_digest: actionIdentity.manifest_digest,
        state_version: input.postMechanicsStateVersion });
      if (identity === undefined) throw new Error("invalid post-mechanics result identity");
      identities.push(identity);
      current.set(action.dynamics_sequence, terminal); if (terminal.disposition === "applied") accepted.add(action.dynamics_sequence);
    }
    const effects = new Map<number, string[]>(); let effectIndex = 0;
    for (const event of input.events) {
      if (!checkedEvent(event)) throw new Error("invalid checked world mechanics event");
      const currentCauses = event.cause_action_sequences.filter((sequence) => current.has(sequence));
      if (currentCauses.some((sequence) => !accepted.has(sequence))) throw new Error("rejected world action caused an event");
      const applicable = event.cause_action_sequences.filter((sequence) => accepted.has(sequence));
      if (applicable.length === 0) continue;
      input.registry.projectEffect(event.kind, event.payload);
      const id = input.reservation.effectId(effectIndex++);
      for (const sequence of applicable) { const values = effects.get(sequence) ?? []; values.push(id); effects.set(sequence, values); }
    }
    const results = input.pending.map((action, index) => {
      const terminal = input.terminals[index]!, base = { version: "simfile.world-action-result.v1" as const, result_id: input.reservation.resultId(index), receipt_id: action.receipt_id, decision_id: action.decision_id, actor: action.holder, action_sequence: action.dynamics_sequence, apply_tick: terminal.apply_tick, identity: identities[index]! };
      return terminal.disposition === "applied" ? frozen({ ...base, status: "applied" as const, caused_effect_ids: frozen(effects.get(action.dynamics_sequence) ?? []) }) : frozen({ ...base, status: "rejected_at_mechanics" as const, rejection_code: terminal.public_code ?? "world_action_rejected" });
    });
    input.reservation.publish(results); return frozen(results);
  } catch (error) { try { input.reservation.abort(); } catch {} throw error; }
};
