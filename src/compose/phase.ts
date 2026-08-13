import {
  appendComposedPhase,
  parseComposedPhaseJournal,
  type ComposedPhaseJournal,
} from "./journal.js";
import {
  composedRunPhaseIndex,
  type ComposedRunFaultInjector,
  type ComposedRunPhase,
} from "./types.js";

export interface ComposedPhaseContext {
  readonly now: () => string;
  readonly persist: (journal: ComposedPhaseJournal) => void | Promise<void>;
  readonly fault_injector?: ComposedRunFaultInjector;
}

export const composedPhaseReached = (
  journal: ComposedPhaseJournal,
  phase: ComposedRunPhase,
): boolean => composedRunPhaseIndex(journal.current_phase) >= composedRunPhaseIndex(phase);

export const composedPhasePayload = (
  rawJournal: unknown,
  phase: ComposedRunPhase,
): Readonly<Record<string, unknown>> => {
  const journal = parseComposedPhaseJournal(rawJournal);
  const entry = journal.entries[composedRunPhaseIndex(phase)];
  if (entry?.phase !== phase) throw new TypeError(`composed phase ${phase} is unavailable`);
  return entry.payload;
};

/** Persists a successful phase before exposing its fault-injection boundary. */
export const commitComposedPhase = async (
  journal: ComposedPhaseJournal,
  phase: ComposedRunPhase,
  payload: Record<string, unknown>,
  context: ComposedPhaseContext,
): Promise<ComposedPhaseJournal> => {
  const next = appendComposedPhase(journal, phase, payload, context.now());
  await context.persist(next);
  await context.fault_injector?.afterPhase?.(phase);
  return next;
};
