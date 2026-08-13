import { types } from "node:util";

import { readWorldRuntimeClockAuthority } from "./clockAuthority.js";
import { readWorldActionResultLedger, type WorldActionResultLedger } from "./actionResultLedger.js";

const registrations = new WeakMap<object, WorldActionResultLedger>();
const owners = new WeakMap<object, object>();

const plainObject = (value: unknown): value is object =>
  value !== null && typeof value === "object" && !types.isProxy(value as object)
  && Object.getPrototypeOf(value) === Object.prototype;

const issuedRuntime = (value: unknown): value is object =>
  plainObject(value) && readWorldRuntimeClockAuthority(value) !== undefined;

const issuedLedger = (value: unknown): value is WorldActionResultLedger => {
  if (!plainObject(value) || readWorldActionResultLedger(value) === undefined) return false;
  const keys = Reflect.ownKeys(value);
  if (keys.length !== 1 || keys[0] !== "read") return false;
  const descriptor = Object.getOwnPropertyDescriptor(value, "read");
  return descriptor?.enumerable === true && descriptor.writable === false
    && descriptor.configurable === false && "value" in descriptor
    && typeof descriptor.value === "function" && Object.isFrozen(value);
};

/** Host-only, one-shot binding of an issued runtime to its issued public result handle. */
export const registerWorldRuntimeActionResultLedgerInspection = (
  runtime: object,
  ledger: WorldActionResultLedger,
): void => {
  if (!issuedRuntime(runtime) || !issuedLedger(ledger) || registrations.has(runtime) || owners.has(ledger)) {
    throw new Error("invalid world action result ledger inspection registration");
  }
  registrations.set(runtime, ledger);
  owners.set(ledger, runtime);
};

export const readWorldRuntimeActionResultLedgerInspection = (
  runtime: unknown,
): WorldActionResultLedger | undefined =>
  issuedRuntime(runtime) ? registrations.get(runtime) : undefined;
