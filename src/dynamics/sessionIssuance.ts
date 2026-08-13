import type { DynamicsSession } from "./sessionContract.js";

const issuedDynamicsSessions = new WeakSet<object>();
const retryableStepFailures = new WeakSet<object>();

export const issueDynamicsRetryableStepFailure = (cause: unknown): Error => {
  const failure = new Error("checked step failed", { cause });
  retryableStepFailures.add(failure);
  return failure;
};

export const isDynamicsRetryableStepFailure = (value: unknown): boolean =>
  value !== null && typeof value === "object" && retryableStepFailures.has(value);

export const readCheckedDynamicsSession = (value: unknown): DynamicsSession | undefined =>
  value !== null && typeof value === "object" && issuedDynamicsSessions.has(value)
    ? value as DynamicsSession
    : undefined;

export const registerCheckedDynamicsSession = (session: DynamicsSession): void => {
  issuedDynamicsSessions.add(session);
};
