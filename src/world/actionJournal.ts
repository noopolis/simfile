import { DYNAMICS_LIMITS } from "../dynamics/limits.js";
import type { QueuedWorldAction, WorldActionTerminal, WorldActQueuedReceipt } from "./actTypes.js";
import {
  cloneWorldActionJournalSnapshot,
  parseQueuedWorldAction,
  parseWorldActionJournalSnapshot,
  parseWorldActionReceipt,
  parseWorldActionTerminal,
  type ActionJournalAudit,
  type WorldActionJournalSnapshot,
} from "./actionJournalSnapshot.js";

export { WORLD_ACTION_JOURNAL_VERSION, type WorldActionJournalSnapshot } from "./actionJournalSnapshot.js";

type CellState = "reserved" | "provisional" | "prepared" | "authorized" | "terminal" | "aborted";
type LiveCell = {
  receipt?: WorldActQueuedReceipt;
  sequence: number;
  state: CellState;
  record?: QueuedWorldAction;
  terminal?: WorldActionTerminal;
};

export interface ActionJournalReservation {
  persist(record: QueuedWorldAction): void;
  prepareAuthorization(): void;
  authorize(): void;
  abort(): void;
}
export interface ActionAuditReservation {
  readonly terminal_capacity: boolean;
  commit(result: "queued" | "denied"): void;
}
/** One issued, all-or-nothing terminal write for a dynamics tick. */
export interface WorldActionTerminalReservation {
  readonly queued: readonly QueuedWorldAction[];
  abort(): void;
  commit(records: readonly WorldActionTerminal[]): void;
}
export interface WorldActionJournal {
  reservePrincipals(principals: readonly string[]): void;
  reserveAudit(principal: string): ActionAuditReservation;
  audit(principal: string, result: "queued" | "denied"): void;
  reserve(receipt: WorldActQueuedReceipt, sequence: number): ActionJournalReservation;
  pending(tick: number): readonly QueuedWorldAction[];
  reserveTerminals(tick: number): WorldActionTerminalReservation;
  terminal(record: WorldActionTerminal): void;
  project(record: WorldActionTerminal): void;
  close(): void;
  snapshot(): WorldActionJournalSnapshot;
  restore(input: unknown): void;
}
export interface WorldActionJournalStatus { readonly closed: boolean; readonly audit_count: number; readonly cell_count: number; }

const issued = new WeakSet<object>();
const statusReaders = new WeakMap<object, () => WorldActionJournalStatus>();
const frozen = <Value>(value: Value): Value => Object.freeze(value);
const validPrincipal = (value: unknown): value is string => typeof value === "string" && value.length > 0
  && value.length <= 256 && value === value.trim();
const closedError = (): Error => new Error("world action journal closed");
const stale = (): never => { throw new Error("stale action journal reservation"); };
const invalid = (): never => { throw new Error("invalid action journal reservation"); };

export const readWorldActionJournal = (value: unknown): WorldActionJournal | undefined =>
  value !== null && typeof value === "object" && issued.has(value) ? value as WorldActionJournal : undefined;

export const readWorldActionJournalStatus = (value: unknown): WorldActionJournalStatus | undefined => {
  if (readWorldActionJournal(value) === undefined) return undefined;
  return statusReaders.get(value as object)?.();
};

export const createWorldActionJournal = (): WorldActionJournal => {
  let lanes = new Map<string, number>();
  let cells = new Map<string, LiveCell>();
  let sequences = new Map<number, string>();
  let audits: ActionJournalAudit[] = [];
  let activeAudits = 0;
  let activeAuditsByPrincipal = new Map<string, number>();
  let closed = false;
  let principalsReserved = false;
  let restored = false;
  let terminalReservation: { readonly cells: readonly LiveCell[]; invalidate(): void } | undefined;

  const close = (): void => {
    terminalReservation?.invalidate();
    closed = true;
  };
  const closeAndThrow = (): never => { close(); throw closedError(); };
  const quiescent = (): boolean => terminalReservation === undefined && activeAudits === 0 && [...cells.values()].every((cell) =>
    cell.state === "authorized" || cell.state === "terminal");
  const pristine = (): boolean => !restored && activeAudits === 0 && audits.length === 0 && cells.size === 0 && !closed;
  const remove = (cell: LiveCell): void => {
    const receipt = cell.receipt;
    if (receipt !== undefined) cells.delete(receipt.receipt_id);
    sequences.delete(cell.sequence);
    cell.receipt = undefined; cell.record = undefined; cell.terminal = undefined;
    cell.sequence = 0; cell.state = "aborted";
  };

  const reserveAudit = (principal: string): ActionAuditReservation => {
    if (!validPrincipal(principal) || !lanes.has(principal)) throw new Error("unknown action journal principal");
    if (closed) throw closedError();
    const count = lanes.get(principal)!;
    const active = activeAuditsByPrincipal.get(principal) ?? 0;
    if (count + active >= DYNAMICS_LIMITS.retained_action_records || audits.length + activeAudits >= DYNAMICS_LIMITS.retained_action_records) {
      return closeAndThrow();
    }
    const terminal_capacity = count + active === DYNAMICS_LIMITS.retained_action_records - 1
      || audits.length + activeAudits === DYNAMICS_LIMITS.retained_action_records - 1;
    activeAudits += 1; activeAuditsByPrincipal.set(principal, active + 1);
    let settled = false;
    return frozen({ terminal_capacity, commit: (result: "queued" | "denied"): void => {
      if (settled || (result !== "queued" && result !== "denied") || (terminal_capacity && result !== "denied")) stale();
      if (closed && result !== "denied") throw closedError();
      audits.push(frozen({ principal, result }));
      lanes.set(principal, lanes.get(principal)! + 1);
      activeAudits -= 1;
      const remaining = (activeAuditsByPrincipal.get(principal) ?? 1) - 1;
      if (remaining === 0) activeAuditsByPrincipal.delete(principal);
      else activeAuditsByPrincipal.set(principal, remaining);
      settled = true;
      if (terminal_capacity) close();
    } });
  };

  const reserve = (receiptInput: WorldActQueuedReceipt, sequence: number): ActionJournalReservation => {
    if (closed || terminalReservation !== undefined) throw closedError();
    const receipt = parseWorldActionReceipt(receiptInput, sequence);
    const safeReceipt: WorldActQueuedReceipt = receipt === undefined ? invalid() : receipt;
    if (!Number.isSafeInteger(sequence) || sequence < 1) invalid();
    if (cells.size >= DYNAMICS_LIMITS.retained_action_records || cells.has(safeReceipt.receipt_id) || sequences.has(sequence)) {
      return closeAndThrow();
    }
    const cell: LiveCell = { receipt: safeReceipt, sequence, state: "reserved" };
    cells.set(safeReceipt.receipt_id, cell); sequences.set(sequence, safeReceipt.receipt_id);
    let settled = false;
    let authorize: () => void;
    let abort: () => void;
    const staleReservation = (): never => stale();
    const successfulAuthorization = (): void => {
      cell.state = "authorized";
      settled = true;
      authorize = staleReservation;
      abort = staleReservation;
    };
    const exactAbort = (): void => {
      remove(cell);
      settled = true;
      authorize = staleReservation;
      abort = staleReservation;
    };
    const unpreparedAuthorization = (): never => { throw new Error("action authorization is not prepared"); };
    authorize = unpreparedAuthorization;
    abort = exactAbort;
    return frozen({
      persist: (record: QueuedWorldAction): void => {
        if (settled || cell.state !== "reserved" || cell.receipt === undefined) invalid();
        const currentReceipt: WorldActQueuedReceipt = cell.receipt === undefined ? invalid() : cell.receipt;
        const cloned = parseQueuedWorldAction(record, currentReceipt, sequence);
        if (cloned === undefined || !lanes.has(cloned.principal)) invalid();
        cell.record = cloned;
        cell.state = "provisional";
      },
      prepareAuthorization: (): void => {
        if (settled || cell.state !== "provisional" || cell.record === undefined) invalid();
        cell.state = "prepared";
        authorize = successfulAuthorization;
      },
      authorize: (): void => authorize(),
      abort: (): void => abort(),
    });
  };

  const reserveTerminals = (tick: number): WorldActionTerminalReservation => {
    if (closed || !Number.isSafeInteger(tick) || tick < 0 || !quiescent()) return closeAndThrow();
    const bound = [...cells.values()].filter((cell) => cell.state === "authorized" && cell.record?.at_tick === tick)
      .sort((left, right) => left.sequence - right.sequence);
    if (bound.length > DYNAMICS_LIMITS.retained_action_records || bound.some((cell) => cell.receipt === undefined || cell.record === undefined)) return closeAndThrow();
    const queued = bound.map((cell) => {
      const record = parseQueuedWorldAction(cell.record!, cell.receipt!, cell.sequence);
      return record === undefined ? closeAndThrow() : record;
    });
    const reservation = { cells: bound, invalidate: (): void => {} };
    terminalReservation = reservation;
    let settled = false;
    const staleTerminal = (): never => stale();
    let abort: () => void;
    let commit: (records: readonly WorldActionTerminal[]) => void;
    const release = (): void => {
      if (terminalReservation === reservation) terminalReservation = undefined;
      settled = true;
      abort = staleTerminal;
      commit = staleTerminal;
    };
    reservation.invalidate = release;
    abort = () => {
      if (settled || terminalReservation !== reservation) staleTerminal();
      release();
    };
    const boundBySequence = new Map(bound.map((cell) => [cell.sequence, cell]));
    commit = (records) => {
      if (settled || terminalReservation !== reservation || !Array.isArray(records) || records.length !== bound.length) return closeAndThrow();
      try {
        const bySequence = new Map<number, WorldActionTerminal>();
        const seen = new Set<number>();
        for (const record of records) {
          if (record === null || typeof record !== "object" || !Number.isSafeInteger(record.sequence) || seen.has(record.sequence)) return closeAndThrow();
          seen.add(record.sequence);
          const cell = boundBySequence.get(record.sequence);
          if (cell === undefined || cell.receipt === undefined || cell.record === undefined) return closeAndThrow();
          const terminal = parseWorldActionTerminal(record, cell.receipt, cell.sequence);
          if (terminal === undefined || terminal.decision_id !== cell.record.decision_id) return closeAndThrow();
          bySequence.set(record.sequence, terminal);
        }
        if (bySequence.size !== bound.length) return closeAndThrow();
        const ordered: Array<Readonly<{ cell: LiveCell; terminal: WorldActionTerminal }>> = [];
        for (let index = 0; index < bound.length; index += 1) {
          const cell = bound[index]!;
          const terminal = bySequence.get(cell.sequence);
          if (terminal === undefined) return closeAndThrow();
          ordered.push({ cell, terminal });
        }
        for (let index = 0; index < ordered.length; index += 1) {
          ordered[index]!.cell.terminal = ordered[index]!.terminal;
          ordered[index]!.cell.state = "terminal";
        }
      } catch {
        return closeAndThrow();
      }
      release();
    };
    return frozen({ queued: frozen(queued), abort: (): void => abort(), commit: (records: readonly WorldActionTerminal[]): void => commit(records) });
  };

  const stableSnapshot = (): WorldActionJournalSnapshot => {
    if (!quiescent()) throw new Error("action journal snapshot requires quiescence");
    const snapshot = {
      version: "simfile.world-action-journal.v1" as const,
      closed,
      lanes: [...lanes.entries()].map(([principal, count]) => ({ principal, count })),
      audits,
      cells: [...cells.values()].map((cell) => {
        if ((cell.state !== "authorized" && cell.state !== "terminal") || cell.receipt === undefined || cell.record === undefined) {
          throw new Error("action journal snapshot requires stable cells");
        }
        return { receipt: cell.receipt, sequence: cell.sequence, state: cell.state,
          record: cell.record, terminal: cell.terminal ?? null };
      }),
    };
    return cloneWorldActionJournalSnapshot(snapshot);
  };

  const journal: WorldActionJournal = frozen({
    reservePrincipals: (principals: readonly string[]): void => {
      if (!pristine() || principalsReserved || !Array.isArray(principals) || principals.length > DYNAMICS_LIMITS.retained_action_records
        || principals.some((principal) => !validPrincipal(principal)) || new Set(principals).size !== principals.length) {
        throw new Error("invalid action journal principals");
      }
      for (const principal of principals) lanes.set(principal, 0);
      principalsReserved = true;
    },
    reserveAudit,
    audit: (principal: string, result: "queued" | "denied"): void => { reserveAudit(principal).commit(result); },
    reserve,
    pending: (tick: number): readonly QueuedWorldAction[] => {
      if (terminalReservation !== undefined) throw new Error("action terminal reservation active");
      if (!Number.isSafeInteger(tick) || tick < 0) return frozen([]);
      const pending: QueuedWorldAction[] = [];
      for (const cell of cells.values()) {
        if (cell.state !== "authorized" || cell.record === undefined || cell.record.at_tick !== tick || cell.receipt === undefined) continue;
        const copy = parseQueuedWorldAction(cell.record, cell.receipt, cell.sequence);
        if (copy === undefined) return closeAndThrow();
        pending.push(copy);
      }
      pending.sort((left, right) => left.dynamics_sequence - right.dynamics_sequence);
      return frozen(pending);
    },
    reserveTerminals,
    terminal: (record: WorldActionTerminal): void => {
      if (closed || terminalReservation !== undefined) throw closedError();
      const sequence = record.sequence;
      const receiptId = Number.isSafeInteger(sequence) ? sequences.get(sequence) : undefined;
      const cell = receiptId === undefined ? undefined : cells.get(receiptId);
      if (cell === undefined || cell.state !== "authorized" || cell.receipt === undefined || cell.record === undefined) return closeAndThrow();
      const terminal = parseWorldActionTerminal(record, cell.receipt, cell.sequence);
      if (terminal === undefined || terminal.decision_id !== cell.record.decision_id) return closeAndThrow();
      cell.terminal = terminal; cell.state = "terminal";
    },
    project: (record: WorldActionTerminal): void => {
      if (closed || terminalReservation !== undefined) throw closedError();
      const sequence = record.sequence;
      const receiptId = Number.isSafeInteger(sequence) ? sequences.get(sequence) : undefined;
      const cell = receiptId === undefined ? undefined : cells.get(receiptId);
      if (cell === undefined || cell.state !== "terminal" || cell.receipt === undefined || cell.terminal?.disposition !== "applied") return closeAndThrow();
      const terminal = parseWorldActionTerminal(record, cell.receipt, cell.sequence);
      if (terminal === undefined || terminal.disposition !== "applied" || terminal.decision_id !== cell.terminal.decision_id) return closeAndThrow();
      cell.terminal = terminal;
    },
    close,
    snapshot: stableSnapshot,
    restore: (input: unknown): void => {
      if (!pristine()) throw new Error("action journal restore requires pristine journal");
      const snapshot = parseWorldActionJournalSnapshot(input);
      if (snapshot === undefined) throw new Error("invalid action journal snapshot");
      const snapshotPrincipals = snapshot.lanes.map((lane) => lane.principal);
      if (principalsReserved && (snapshotPrincipals.length !== lanes.size || snapshotPrincipals.some((principal) => !lanes.has(principal)))) {
        throw new Error("action journal restore principal mismatch");
      }
      lanes = new Map(snapshot.lanes.map((lane) => [lane.principal, lane.count]));
      cells = new Map(snapshot.cells.map((cell) => [cell.receipt.receipt_id, {
        receipt: cell.receipt, sequence: cell.sequence, state: cell.state, record: cell.record,
        ...(cell.terminal === null ? {} : { terminal: cell.terminal }),
      }]));
      sequences = new Map(snapshot.cells.map((cell) => [cell.sequence, cell.receipt.receipt_id]));
      audits = [...snapshot.audits]; closed = snapshot.closed; restored = true; principalsReserved = true;
    },
  });
  issued.add(journal);
  statusReaders.set(journal, () => Object.freeze({ closed, audit_count: audits.length, cell_count: cells.size }));
  return journal;
};
