import type {
  MoltnetMessageActor,
  MoltnetMessagePart,
  MoltnetMessageTarget,
  MoltnetWorldDeliveryOptions
} from "./world-participant.js";

const DEFAULT_LIMIT = 200;
const DEFAULT_TIMEOUT_MS = 10_000;

export type TranscriptSource = "harness-derived" | "moltnet-exported";

export interface MoltnetTranscriptTarget {
  kind: "dm" | "room";
  id: string;
  scope?: string;
}

export interface MoltnetExportedTranscriptMessage {
  from?: MoltnetMessageActor;
  id: string;
  parts?: MoltnetMessagePart[];
  target?: MoltnetMessageTarget;
}

export interface MoltnetConversationTranscript {
  messages: MoltnetExportedTranscriptMessage[];
  target: MoltnetTranscriptTarget;
}

export interface MoltnetExportedTranscript {
  conversations: MoltnetConversationTranscript[];
  source: "moltnet-exported";
  version: "simfile.moltnet.transcript.v1";
}

export interface TranscriptSourceArtifact {
  source?: TranscriptSource;
}

export interface ExportMoltnetTranscriptOptions extends MoltnetWorldDeliveryOptions {
  limit?: number;
  targets: readonly MoltnetTranscriptTarget[];
}

export const roomTranscriptTargetFromScope = (scope: string): MoltnetTranscriptTarget => {
  const [kind, network, room] = scope.split(":");
  if (kind !== "room" || !network || !room) {
    throw new Error(`invalid room scope ${scope}`);
  }
  return { kind: "room", id: room, scope };
};

const requestHeaders = (options: Pick<MoltnetWorldDeliveryOptions, "authToken">): HeadersInit => ({
  ...(options.authToken?.trim() ? { Authorization: `Bearer ${options.authToken.trim()}` } : {})
});

const readJSON = async <T>(url: URL, options: MoltnetWorldDeliveryOptions): Promise<T> => {
  const timeout = options.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS;
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

const transcriptPath = (target: MoltnetTranscriptTarget, limit: number): string => {
  const encodedId = encodeURIComponent(target.id);
  const encodedLimit = encodeURIComponent(String(limit));
  return target.kind === "room"
    ? `/v1/rooms/${encodedId}/messages?limit=${encodedLimit}`
    : `/v1/dms/${encodedId}/messages?limit=${encodedLimit}`;
};

export const extractSimfileEventIds = (
  transcript: MoltnetExportedTranscript
): string[] => {
  const ids = new Set<string>();
  for (const conversation of transcript.conversations) {
    for (const message of conversation.messages) {
      const data = message.parts?.[0]?.data;
      const eventId = data && typeof data === "object"
        ? (data as Record<string, unknown>).simfile_event_id
        : undefined;
      if (typeof eventId === "string") ids.add(eventId);
    }
  }
  return [...ids].sort();
};

export const requireMoltnetExportedTranscript = (
  artifact: TranscriptSourceArtifact
): void => {
  if (artifact.source !== "moltnet-exported") {
    throw new Error("live simulation acceptance requires a moltnet-exported transcript");
  }
};

export const exportMoltnetTranscript = async (
  options: ExportMoltnetTranscriptOptions
): Promise<MoltnetExportedTranscript> => {
  const base = options.baseUrl.replace(/\/+$/u, "");
  const limit = Math.max(1, Math.floor(options.limit ?? DEFAULT_LIMIT));
  const conversations: MoltnetConversationTranscript[] = [];
  for (const target of options.targets) {
    const page = await readJSON<{ messages?: MoltnetExportedTranscriptMessage[] }>(
      new URL(`${base}${transcriptPath(target, limit)}`),
      options
    );
    conversations.push({
      messages: page.messages ?? [],
      target
    });
  }
  return {
    conversations,
    source: "moltnet-exported",
    version: "simfile.moltnet.transcript.v1"
  };
};
