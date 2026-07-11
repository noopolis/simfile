/**
 * Generic bounded-retry poll helper, reused by the composed-run driver for
 * every read-only readiness check (moltnet health, room membership, agent
 * bridge attachment) before the ONE seed write. Ported from the shape of
 * `src/e2e/moltnetE2ESupport.ts`'s `poll` (not imported — this package may
 * not depend on Spawnfile internals) since the polling contract itself is
 * generic and has nothing Spawnfile-specific about it.
 */
export interface PollOptions {
  intervalMs: number;
  sleep: (delayMs: number) => Promise<void>;
  timeoutMs: number;
}

export const defaultSleep = async (delayMs: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, delayMs);
  });

/** Retries `attempt` until it returns a truthy value or the timeout elapses;
 * throws a description-carrying error otherwise. Never coaxes/mutates state —
 * every attempt is a read. */
export const pollUntilReady = async <T>(
  description: string,
  options: PollOptions,
  attempt: () => Promise<T | null>
): Promise<T> => {
  const attempts = Math.max(1, Math.ceil(options.timeoutMs / options.intervalMs));
  let lastError: unknown;
  for (let index = 0; index <= attempts; index += 1) {
    try {
      const result = await attempt();
      if (result) return result;
    } catch (error) {
      lastError = error;
    }
    await options.sleep(options.intervalMs);
  }
  const suffix = lastError instanceof Error ? `: ${lastError.message}` : "";
  throw new Error(`${description} did not become ready${suffix}`);
};
