export interface McpSessionResource {
  close(): Promise<void>;
}

export interface McpSession<Value extends McpSessionResource> {
  readonly id: string;
  readonly bearer: string;
  readonly value: Value;
}

export interface McpSessionLease<Value extends McpSessionResource> {
  readonly session: McpSession<Value>;
  release(): void;
}

export interface McpSessionReservation<Value extends McpSessionResource> {
  commit(id: string, bearer: string, value: Value): McpSessionLease<Value> | undefined;
  release(): void;
}

export interface McpSessionLifecycle<Value extends McpSessionResource> {
  reserve(): McpSessionReservation<Value> | undefined;
  has(id: string): boolean;
  lookup(id: string): McpSession<Value> | undefined;
  acquire(id: string): McpSessionLease<Value> | undefined;
  dispose(session: McpSession<Value>): Promise<void>;
  disposeExact(id: string, bearer: string): Promise<boolean>;
  close(): Promise<void>;
}

export interface CreateMcpSessionLifecycleInput {
  readonly maxSessions: number;
  readonly idleTtlMs: number;
  readonly closeTimeoutMs: number;
}

type Entry<Value extends McpSessionResource> = {
  readonly session: McpSession<Value>;
  active: number;
  timer?: ReturnType<typeof setTimeout>;
  closing?: Promise<void>;
};
const MAX_TIMER_MS = 60_000;

const clearIdleTimer = (entry: Entry<McpSessionResource>): void => {
  if (entry.timer !== undefined) clearTimeout(entry.timer);
  entry.timer = undefined;
};

const bounded = async (promise: Promise<unknown>, timeoutMs: number): Promise<void> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutMs);
  });
  await Promise.race([promise.then(() => undefined, () => undefined), timeout]);
  if (timer !== undefined) clearTimeout(timer);
};

/** Owns bounded admission and disposal for bearer-bound MCP session resources. */
export const createMcpSessionLifecycle = <Value extends McpSessionResource>(
  input: CreateMcpSessionLifecycleInput,
): McpSessionLifecycle<Value> => {
  if (!Number.isSafeInteger(input.maxSessions) || input.maxSessions < 1
    || !Number.isSafeInteger(input.idleTtlMs) || input.idleTtlMs < 1 || input.idleTtlMs > MAX_TIMER_MS
    || !Number.isSafeInteger(input.closeTimeoutMs) || input.closeTimeoutMs < 1 || input.closeTimeoutMs > MAX_TIMER_MS) {
    throw new TypeError("invalid MCP session lifecycle configuration");
  }
  const sessions = new Map<string, Entry<Value>>();
  const reservations = new Set<McpSessionReservation<Value>>();
  const closingResources = new Set<Promise<void>>();
  const known = new WeakMap<object, Entry<Value>>();
  let occupied = 0;
  let stopped = false;
  let closePromise: Promise<void> | undefined;

  const dispose = (session: McpSession<Value>): Promise<void> => {
    const entry = known.get(session as object);
    if (entry === undefined) return Promise.resolve();
    if (entry.closing !== undefined) return entry.closing;
    if (sessions.get(entry.session.id) !== entry) return Promise.resolve();
    sessions.delete(entry.session.id);
    clearIdleTimer(entry);
    occupied -= 1;
    const attempted = Promise.resolve().then(() => entry.session.value.close());
    const pending = bounded(attempted, input.closeTimeoutMs)
      .finally(() => { closingResources.delete(pending); });
    entry.closing = pending;
    closingResources.add(pending);
    return pending;
  };

  const scheduleIdle = (entry: Entry<Value>): void => {
    if (stopped || entry.active !== 0 || entry.closing !== undefined || sessions.get(entry.session.id) !== entry) return;
    clearIdleTimer(entry);
    entry.timer = setTimeout(() => { entry.timer = undefined; void dispose(entry.session); }, input.idleTtlMs);
    entry.timer.unref?.();
  };

  const lease = (entry: Entry<Value>): McpSessionLease<Value> => {
    clearIdleTimer(entry);
    entry.active += 1;
    let released = false;
    return Object.freeze({
      session: entry.session,
      release: (): void => {
        if (released) return;
        released = true;
        entry.active -= 1;
        scheduleIdle(entry);
      },
    });
  };

  const reserve = (): McpSessionReservation<Value> | undefined => {
    if (stopped || occupied >= input.maxSessions) return undefined;
    occupied += 1;
    let state: "pending" | "committed" | "released" = "pending";
    const reservation: McpSessionReservation<Value> = Object.freeze({
      commit: (id: string, bearer: string, value: Value): McpSessionLease<Value> | undefined => {
        if (state !== "pending") return undefined;
        reservations.delete(reservation);
        if (stopped || sessions.has(id)) {
          state = "released";
          occupied -= 1;
          return undefined;
        }
        state = "committed";
        const session = Object.freeze({ id, bearer, value });
        const entry: Entry<Value> = { session, active: 0 };
        known.set(session, entry);
        sessions.set(id, entry);
        return lease(entry);
      },
      release: (): void => {
        if (state !== "pending") return;
        state = "released";
        reservations.delete(reservation);
        occupied -= 1;
      },
    });
    reservations.add(reservation);
    return reservation;
  };

  const close = (): Promise<void> => {
    if (closePromise !== undefined) return closePromise;
    stopped = true;
    for (const reservation of [...reservations]) reservation.release();
    closePromise = (async () => {
      await Promise.allSettled([...sessions.values()].map((entry) => dispose(entry.session)));
      await Promise.allSettled([...closingResources]);
    })();
    return closePromise;
  };

  return Object.freeze({
    reserve,
    has: (id: string): boolean => sessions.has(id),
    lookup: (id: string): McpSession<Value> | undefined => sessions.get(id)?.session,
    acquire: (id: string): McpSessionLease<Value> | undefined => {
      const entry = stopped ? undefined : sessions.get(id);
      return entry === undefined || entry.closing !== undefined ? undefined : lease(entry);
    },
    dispose,
    disposeExact: async (id: string, bearer: string): Promise<boolean> => {
      const entry = sessions.get(id);
      if (entry === undefined || entry.session.bearer !== bearer) return false;
      await dispose(entry.session);
      return true;
    },
    close,
  });
};
