/**
 * Read-only Moltnet HTTP polling helpers for the composed-run driver —
 * `/healthz`, `/v1/rooms/:id`, `/v1/agents`, `/v1/rooms/:id/messages` are
 * Moltnet's own public wire API (documented, not a Spawnfile internal), the
 * same endpoints `src/e2e/moltnetE2ESupport.ts`'s `createMoltnetHttpClient`
 * speaks — reimplemented locally here (never imported from Spawnfile's
 * `src/e2e`) so this package's charter ("Do not import Spawnfile internals")
 * holds. Every function here is a plain GET: seeding (the one write this
 * driver ever performs) goes through `world-participant.ts` instead.
 */

export interface MoltnetRoomSummary {
  id: string;
  members: string[];
}

export interface MoltnetAgentSummary {
  id: string;
  rooms: string[];
  connected: boolean;
}

export interface MoltnetRoomMessage {
  id: string;
  from: { id: string; type?: string };
  parts: { kind: string; text?: string }[];
  created_at?: string;
}

export interface MoltnetRoomClientOptions {
  fetchFn?: typeof fetch;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;

const fetchJson = async <T>(
  url: string,
  options: MoltnetRoomClientOptions | undefined
): Promise<T> => {
  const timeout = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const signal = timeout > 0 ? AbortSignal.timeout(timeout) : undefined;
  const response = await (options?.fetchFn ?? fetch)(url, { method: "GET", ...(signal ? { signal } : {}) });
  if (!response.ok) {
    throw new Error(`moltnet GET ${url} returned ${response.status}`);
  }
  return (await response.json()) as T;
};

/** Read-only health probe; never throws — a not-yet-ready server is a
 * negative poll result, not an error. */
export const moltnetHealthy = async (baseUrl: string, options?: MoltnetRoomClientOptions): Promise<boolean> => {
  try {
    const timeout = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const signal = timeout > 0 ? AbortSignal.timeout(timeout) : undefined;
    const response = await (options?.fetchFn ?? fetch)(`${baseUrl}/healthz`, { method: "GET", ...(signal ? { signal } : {}) });
    return response.ok;
  } catch {
    return false;
  }
};

export const getMoltnetRoom = async (
  baseUrl: string,
  roomId: string,
  options?: MoltnetRoomClientOptions
): Promise<MoltnetRoomSummary> => fetchJson(`${baseUrl}/v1/rooms/${encodeURIComponent(roomId)}`, options);

export const listMoltnetAgents = async (
  baseUrl: string,
  options?: MoltnetRoomClientOptions
): Promise<MoltnetAgentSummary[]> =>
  (await fetchJson<{ agents?: MoltnetAgentSummary[] }>(`${baseUrl}/v1/agents`, options)).agents ?? [];

export const listMoltnetRoomMessages = async (
  baseUrl: string,
  roomId: string,
  limit: number,
  options?: MoltnetRoomClientOptions
): Promise<MoltnetRoomMessage[]> =>
  (
    await fetchJson<{ messages?: MoltnetRoomMessage[] }>(
      `${baseUrl}/v1/rooms/${encodeURIComponent(roomId)}/messages?limit=${limit}`,
      options
    )
  ).messages ?? [];

/** True once every expected member both appears in room config membership
 * AND has a live, connected bridge attachment — mirrors
 * `moltnetE2ESupport.ts`'s `waitForAgents` gate (room membership alone can be
 * static config, seeding before the bridge attaches is unrecoverable). */
export const allMembersConnected = (
  agents: readonly MoltnetAgentSummary[],
  roomId: string,
  expectedMembers: readonly string[]
): boolean =>
  expectedMembers.every((id) =>
    agents.some((agent) => agent.id === id && agent.rooms.includes(roomId) && agent.connected === true)
  );
