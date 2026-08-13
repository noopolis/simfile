import type { RuntimeTraceEvent } from "../runtime/types.js";

export const WORLD_MESSAGE_EVENT_KINDS = ["world.message", "world.dm"] as const;
type WorldMessageEventKind = (typeof WORLD_MESSAGE_EVENT_KINDS)[number];

const WORLD_ACTOR_ID = "world";
const WORLD_ACTOR_NAME = "@world";
const WORLD_HTTP_TIMEOUT_MS = 10_000;
const WORLD_EVENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

interface RoomScope {
  network: string;
  room: string;
}

export interface MoltnetMessageActor {
  type: "agent";
  id: string;
  name?: string;
  network_id?: string;
}

export interface MoltnetMessageTarget {
  kind: "room" | "dm";
  room_id?: string;
  dm_id?: string;
  participant_ids?: string[];
}

export interface MoltnetMessagePart {
  kind: "text";
  text: string;
  data?: Record<string, unknown>;
}

interface MoltnetMessageOrigin {
  network_id: string;
  message_id: string;
}

export interface MoltnetSendMessageRequest {
  id?: string;
  origin?: MoltnetMessageOrigin;
  target: MoltnetMessageTarget;
  from: MoltnetMessageActor;
  parts: MoltnetMessagePart[];
}

export interface MoltnetMessageAccepted {
  message_id: string;
  event_id: string;
  accepted: boolean;
  thread_created: boolean;
  dm_created: boolean;
}

export interface MoltnetWorldDeliveryOptions {
  actorId?: string;
  actorName?: string;
  authToken?: string;
  baseUrl: string;
  networkId?: string;
  buildDmId?: (network: string, agentId: string, event: RuntimeTraceEvent) => string;
  fetchFn?: typeof fetch;
  requestTimeoutMs?: number;
}

export interface MoltnetWorldDeliveryResult {
  eventId: string;
  request: MoltnetSendMessageRequest;
  response: MoltnetMessageAccepted;
}

export interface MoltnetTranscriptMessage {
  from?: MoltnetMessageActor;
  id: string;
  parts?: MoltnetMessagePart[];
  target?: MoltnetMessageTarget;
}

export interface MoltnetWorldTranscriptEntry {
  eventId?: string;
  kind?: string;
  message: MoltnetTranscriptMessage;
  target: MoltnetMessageTarget;
}

export interface MoltnetWorldTranscriptOptions extends MoltnetWorldDeliveryOptions {
  events: readonly RuntimeTraceEvent[];
}

export const isWorldMessageEvent = (event: RuntimeTraceEvent): event is RuntimeTraceEvent & { kind: WorldMessageEventKind } =>
  WORLD_MESSAGE_EVENT_KINDS.includes(event.kind as WorldMessageEventKind);

const asRoomScope = (scope: string): RoomScope => {
  const [kind, network, room] = scope.split(":");
  if (kind !== "room" || !network || !room) {
    throw new Error(`invalid room target scope ${scope}`);
  }
  return { network, room };
};

const asAgentScope = (scope: string): string => {
  const [kind, agent] = scope.split(":");
  if (kind !== "agent" || !agent) {
    throw new Error(`invalid agent target scope ${scope}`);
  }
  return agent;
};

const defaultActor = (networkId?: string): MoltnetMessageActor => ({
  type: "agent",
  id: WORLD_ACTOR_ID,
  name: WORLD_ACTOR_NAME,
  ...(networkId ? { network_id: networkId } : {})
});

const defaultDmId = (network: string, agentId: string, event: RuntimeTraceEvent): string =>
  `world-${network}-${agentId}`;

const deriveActorNetworkId = (event: RuntimeTraceEvent, options: MoltnetWorldDeliveryOptions): string | undefined => {
  if (options.networkId) return options.networkId;
  if (event.kind === "world.message") {
    return asRoomScope(event.target).network;
  }
  return undefined;
}

const requestTextFromEvent = (event: RuntimeTraceEvent): string => {
  const payload = typeof event.payload === "object" && event.payload !== null && !Array.isArray(event.payload)
    ? event.payload as Record<string, unknown>
    : {};

  if (typeof payload.content === "string" && payload.content.length > 0) {
    return payload.content;
  }
  if (typeof payload.reason === "string" && payload.reason.length > 0) {
    return `${event.kind}: ${payload.reason}`;
  }
  return `${event.kind}: ${event.target}`;
};

const metadataFromEvent = (event: RuntimeTraceEvent): Record<string, unknown> => ({
  simfile_event_id: event.event_id,
  simfile_event_kind: event.kind,
  simfile_rule_id: event.actor
});

const requestHeaders = (options: Pick<MoltnetWorldDeliveryOptions, "authToken">): HeadersInit => ({
  "Content-Type": "application/json",
  ...(options.authToken?.trim() ? { Authorization: `Bearer ${options.authToken.trim()}` } : {})
});

const requestFromWorldEvent = (
  event: RuntimeTraceEvent & { kind: WorldMessageEventKind },
  options: MoltnetWorldDeliveryOptions
): MoltnetSendMessageRequest => {
  const actorNetwork = deriveActorNetworkId(event, options);
  const metadata = metadataFromEvent(event);
  const messageText = requestTextFromEvent(event);

  if (event.kind === "world.dm") {
    const actorId = options.actorId?.trim() || WORLD_ACTOR_ID;
    const network = options.networkId ?? actorNetwork;
    if (!network) {
      throw new Error("networkId is required for world.dm delivery");
    }
    const toAgent = asAgentScope(event.target);
    const dmIdFactory = options.buildDmId ?? defaultDmId;
    const dmId = dmIdFactory(network, toAgent, event);
    return {
      id: WORLD_EVENT_ID_PATTERN.test(event.event_id) ? event.event_id : undefined,
      origin: { network_id: network, message_id: event.event_id },
      from: {
        ...defaultActor(network),
        id: actorId
      },
      target: {
        kind: "dm",
        dm_id: dmId,
        participant_ids: [actorId, toAgent]
      },
      parts: [{
        kind: "text",
        text: messageText,
        data: metadata
      }]
    };
  }

  const roomScope = asRoomScope(event.target);
  const actorId = options.actorId?.trim() || WORLD_ACTOR_ID;
  return {
    id: WORLD_EVENT_ID_PATTERN.test(event.event_id) ? event.event_id : undefined,
    origin: { network_id: roomScope.network, message_id: event.event_id },
    from: {
      ...defaultActor(roomScope.network),
      id: actorId
    },
    target: {
      kind: "room",
      room_id: roomScope.room
    },
    parts: [{
      kind: "text",
      text: messageText,
      data: metadata
    }]
  };
};

const parseMoltnetAccepted = async (response: Response): Promise<MoltnetMessageAccepted> => {
  const body = await response.text();
  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch (error: unknown) {
    throw new Error(`moltnet response decode failed: ${(error as Error).message}`);
  }

  const message = payload as Record<string, unknown>;
  if (
    typeof message !== "object" ||
    message === null ||
    typeof message.message_id !== "string" ||
    typeof message.event_id !== "string" ||
    typeof message.accepted !== "boolean" ||
    typeof message.thread_created !== "boolean" ||
    typeof message.dm_created !== "boolean"
  ) {
    throw new Error("moltnet response missing expected fields");
  }

  return message as unknown as MoltnetMessageAccepted;
};

export const buildMoltnetMessageRequest = (
  event: RuntimeTraceEvent,
  options: MoltnetWorldDeliveryOptions
): MoltnetSendMessageRequest => {
  if (!isWorldMessageEvent(event)) {
    throw new Error(`unsupported event kind ${event.kind}`);
  }
  return requestFromWorldEvent(event, options);
};

export const sendWorldEventToMoltnet = async (
  event: RuntimeTraceEvent,
  options: MoltnetWorldDeliveryOptions
): Promise<MoltnetWorldDeliveryResult> => {
  const request = buildMoltnetMessageRequest(event, options);
  const requestTarget = new URL(`${options.baseUrl.replace(/\/+$/u, "")}/v1/messages`);
  const timeout = options.requestTimeoutMs ?? WORLD_HTTP_TIMEOUT_MS;
  const signal = timeout > 0 ? AbortSignal.timeout(timeout) : undefined;
  const fetcher = options.fetchFn ?? fetch;

  const response = await fetcher(requestTarget.href, {
    method: "POST",
    headers: requestHeaders(options),
    body: JSON.stringify(request),
    ...(signal ? { signal } : {})
  });
  if (!response.ok) {
    throw new Error(`moltnet endpoint ${response.status} ${response.statusText}`);
  }

  const accepted = await parseMoltnetAccepted(response);
  return { eventId: event.event_id, request, response: accepted };
};

export const sendWorldEventsToMoltnet = async (
  events: readonly RuntimeTraceEvent[],
  options: MoltnetWorldDeliveryOptions
): Promise<MoltnetWorldDeliveryResult[]> => {
  const results: MoltnetWorldDeliveryResult[] = [];
  for (const event of events) {
    if (!isWorldMessageEvent(event)) continue;
    results.push(await sendWorldEventToMoltnet(event, options));
  }
  return results;
};

const readJSON = async <T>(url: URL, options: MoltnetWorldDeliveryOptions): Promise<T> => {
  const timeout = options.requestTimeoutMs ?? WORLD_HTTP_TIMEOUT_MS;
  const signal = timeout > 0 ? AbortSignal.timeout(timeout) : undefined;
  const response = await (options.fetchFn ?? fetch)(url.href, {
    method: "GET",
    headers: requestHeaders(options),
    ...(signal ? { signal } : {})
  });
  if (!response.ok) {
    throw new Error(`moltnet endpoint ${response.status} ${response.statusText}`);
  }
  return await response.json() as T;
};

const transcriptTargets = (
  events: readonly RuntimeTraceEvent[],
  options: MoltnetWorldDeliveryOptions
): MoltnetMessageTarget[] => {
  const targets = new Map<string, MoltnetMessageTarget>();
  for (const event of events) {
    if (!isWorldMessageEvent(event)) continue;
    const request = buildMoltnetMessageRequest(event, options);
    const target = request.target;
    if (target.kind === "room" && target.room_id) {
      targets.set(`room:${target.room_id}`, target);
    }
    if (target.kind === "dm" && target.dm_id) {
      targets.set(`dm:${target.dm_id}`, target);
    }
  }
  return [...targets.values()];
};

const firstPartMetadata = (message: MoltnetTranscriptMessage): Record<string, unknown> | undefined => {
  const data = message.parts?.[0]?.data;
  return data && typeof data === "object" ? data : undefined;
};

export const readWorldTranscriptFromMoltnet = async (
  options: MoltnetWorldTranscriptOptions
): Promise<MoltnetWorldTranscriptEntry[]> => {
  const base = options.baseUrl.replace(/\/+$/u, "");
  const entries: MoltnetWorldTranscriptEntry[] = [];
  for (const target of transcriptTargets(options.events, options)) {
    const path = target.kind === "room" && target.room_id
      ? `/v1/rooms/${encodeURIComponent(target.room_id)}/messages?limit=200`
      : target.kind === "dm" && target.dm_id
        ? `/v1/dms/${encodeURIComponent(target.dm_id)}/messages?limit=200`
        : undefined;
    if (!path) continue;
    const page = await readJSON<{ messages?: MoltnetTranscriptMessage[] }>(new URL(`${base}${path}`), options);
    for (const message of page.messages ?? []) {
      const data = firstPartMetadata(message);
      if (typeof data?.simfile_event_id !== "string") continue;
      entries.push({
        eventId: data.simfile_event_id,
        kind: typeof data.simfile_event_kind === "string" ? data.simfile_event_kind : undefined,
        message,
        target
      });
    }
  }
  return entries;
};
