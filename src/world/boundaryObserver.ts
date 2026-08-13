export interface WorldBoundaryObservation {
  readonly operation: string;
  readonly principal: string;
  readonly request: Uint8Array;
}

export interface WorldBoundaryReservation {
  complete(input: Readonly<{ readonly status: number; readonly response: Uint8Array }>): void;
}

export interface WorldBoundaryObserver {
  begin(input: WorldBoundaryObservation): WorldBoundaryReservation;
}

const observers = new WeakMap<object, WorldBoundaryObserver>();

/** Host-only registration. The observer receives no bearer credential. */
export const registerWorldBoundaryObserver = (
  runtime: object,
  observer: WorldBoundaryObserver,
): void => {
  if (runtime === null || typeof runtime !== "object" || observers.has(runtime)
    || observer === null || typeof observer !== "object" || typeof observer.begin !== "function") {
    throw new TypeError("invalid world boundary observer registration");
  }
  observers.set(runtime, observer);
};

export const readWorldBoundaryObserver = (
  runtime: unknown,
): WorldBoundaryObserver | undefined =>
  runtime !== null && typeof runtime === "object" ? observers.get(runtime) : undefined;
