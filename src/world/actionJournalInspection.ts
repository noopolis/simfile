import { readWorldActionJournal, readWorldActionJournalStatus, type WorldActionJournal, type WorldActionJournalStatus } from "./actionJournal.js";
import type { WorldActionJournalSnapshot } from "./actionJournalSnapshot.js";
import { readWorldActionRefusalJournal, type WorldActionRefusalJournal, type WorldActionRefusalReadPort } from "./actionRefusalJournal.js";

export interface WorldActionJournalInspection {
  snapshot(): WorldActionJournalSnapshot;
  status(): WorldActionJournalStatus;
}

const inspections = new WeakMap<object, WorldActionJournalInspection>();
const refusalInspections = new WeakMap<object, WorldActionRefusalReadPort>();

export const registerWorldRuntimeActionJournalInspection = (
  runtime: object,
  journal: WorldActionJournal,
): void => {
  if (inspections.has(runtime)) throw new Error("world action journal inspection already issued");
  const issuedJournal = readWorldActionJournal(journal);
  if (issuedJournal === undefined) throw new Error("world action journal inspection requires an issued journal");
  const inspection: WorldActionJournalInspection = Object.freeze({
    snapshot: () => issuedJournal.snapshot(),
    status: () => {
      const status = readWorldActionJournalStatus(issuedJournal);
      if (status === undefined) throw new Error("world action journal inspection is unavailable");
      return status;
    },
  });
  inspections.set(runtime, inspection);
};

export const readWorldRuntimeActionJournalInspection = (
  runtime: unknown,
): WorldActionJournalInspection | undefined =>
  runtime !== null && typeof runtime === "object" ? inspections.get(runtime) : undefined;

export const registerWorldRuntimeActionRefusalJournalInspection = (
  runtime: object,
  journal: WorldActionRefusalJournal,
): void => {
  if (refusalInspections.has(runtime)) {
    throw new Error("world action refusal inspection already issued");
  }
  const issuedJournal = readWorldActionRefusalJournal(journal);
  if (issuedJournal === undefined) {
    throw new Error("world action refusal inspection requires an issued journal");
  }
  refusalInspections.set(runtime, Object.freeze({
    acknowledge: (ordinal: number): void => issuedJournal.acknowledge(ordinal),
    read: (afterOrdinal: number) => issuedJournal.read(afterOrdinal),
  }));
};

export const readWorldRuntimeActionRefusalJournalInspection = (
  runtime: unknown,
): WorldActionRefusalReadPort | undefined =>
  runtime !== null && typeof runtime === "object"
    ? refusalInspections.get(runtime)
    : undefined;
