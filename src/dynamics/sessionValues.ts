import { cloneDynamicsJsonObject } from "./canonicalJson.js";
import type {
  DynamicsActionAttempt,
  DynamicsActionIngressRecord,
  DynamicsActionQueueReceipt,
  DynamicsCommand,
  DynamicsJsonValue,
  DynamicsQueuedAction
} from "./types.js";

/**
 * Value copying and freezing for the dynamics session: the defensive copies
 * that keep host-retained action records immutable from a provider's reach,
 * and the frozen, identity-free command a provider actually sees.
 *
 * Extracted from `session.ts` unchanged (behavior-preserving) to keep that
 * file under the repo's 400-line ceiling. The deep freeze is load-bearing: a
 * provider must not be able to mutate the input the host has already retained.
 */

export const cloneReceipt = (receipt: DynamicsActionQueueReceipt): DynamicsActionQueueReceipt => ({ ...receipt });

export const cloneAttempt = (attempt: DynamicsActionAttempt): DynamicsActionAttempt => ({
  ...attempt,
  input: cloneDynamicsJsonObject(attempt.input, "dynamics action attempt.input")
});

export const cloneQueuedAction = (action: DynamicsQueuedAction): DynamicsQueuedAction => ({
  ...cloneAttempt(action),
  sequence: action.sequence
});

export const cloneIngressRecord = (record: DynamicsActionIngressRecord): DynamicsActionIngressRecord => ({
  attempt: cloneAttempt(record.attempt),
  receipt: cloneReceipt(record.receipt)
});

export const freezeJson = <T extends DynamicsJsonValue>(value: T): T => {
  if (Array.isArray(value)) for (const entry of value) freezeJson(entry);
  else if (typeof value === "object" && value !== null) {
    for (const entry of Object.values(value)) freezeJson(entry);
  }
  return Object.freeze(value);
};

export const providerCommand = (action: DynamicsQueuedAction): DynamicsCommand => {
  const input = freezeJson(cloneDynamicsJsonObject(action.input, "dynamics command.input"));
  return Object.freeze({
    action: action.action,
    actor: action.actor,
    input,
    sequence: action.sequence,
    target: action.target
  });
};
