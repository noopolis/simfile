import type { WorldRequestLedger } from "./requestLedger.js";
import type { WorldRequestLedgerSnapshot } from "./requestLedgerSnapshot.js";

export interface WorldRequestLedgerInspection {
  snapshot(): WorldRequestLedgerSnapshot;
}

const inspections = new WeakMap<object, WorldRequestLedgerInspection>();

export const registerWorldRuntimeRequestLedgerInspection = (runtime: object, ledger: WorldRequestLedger): void => {
  if (inspections.has(runtime)) throw new Error("world request ledger inspection already issued");
  inspections.set(runtime, Object.freeze({ snapshot: () => ledger.snapshot() }));
};

export const readWorldRuntimeRequestLedgerInspection = (runtime: unknown): WorldRequestLedgerInspection | undefined =>
  runtime !== null && typeof runtime === "object" ? inspections.get(runtime) : undefined;
