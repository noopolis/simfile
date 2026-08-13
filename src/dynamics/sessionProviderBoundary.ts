import {
  canonicalDynamicsJson,
  cloneDynamicsJson,
} from "./canonicalJson.js";
import type { DynamicsJsonValue, DynamicsProvider } from "./types.js";

const isPromiseLike = (value: unknown): value is PromiseLike<unknown> =>
  typeof value === "object" && value !== null
  && typeof (value as { then?: unknown }).then === "function";

export const requireSynchronous = <T>(
  value: T,
  method: string,
): Exclude<T, PromiseLike<unknown>> => {
  if (isPromiseLike(value)) throw new Error(`dynamics provider ${method}() must be synchronous`);
  return value as Exclude<T, PromiseLike<unknown>>;
};

export const sameDynamicsJson = (left: unknown, right: unknown): boolean =>
  canonicalDynamicsJson(left) === canonicalDynamicsJson(right);

export const restoreProviderExactly = (
  provider: DynamicsProvider,
  snapshot: DynamicsJsonValue,
): void => {
  requireSynchronous(provider.restore(cloneDynamicsJson(snapshot)), "restore");
  const restored = cloneDynamicsJson(
    requireSynchronous(provider.snapshot(), "snapshot"),
    "dynamics provider snapshot",
  );
  if (!sameDynamicsJson(restored, snapshot)) {
    throw new Error("dynamics provider restore() did not reproduce the requested snapshot");
  }
};

export const describeRollbackFailure = (error: unknown): string => {
  if (error instanceof Error) return error.stack ?? error.message;
  return String(error);
};
