import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import type { CausalEvent } from "@noopolis/stele";

import { findRunRawFiles } from "./rawFiles.js";

export interface SocialTranscriptMessage {
  id: string;
  rendered_attribution: string;
  parts: unknown[];
}

export interface SocialPlaneMessage {
  message_id: string;
  rendered_attribution: string;
  authenticated_principal: string | null;
  attribution: "attested" | "violated" | "unattested";
  content_sha256_matches: boolean;
}

export interface SocialPlane {
  messages: { count: number; entries: SocialPlaneMessage[] };
  world_state: { passed: boolean; violations: { message_id: string; keys: string[] }[] };
  actions: {
    passed: boolean;
    basis: string;
    violations: { message_id: string; action_event_id: string; relation: "causal-ancestor" }[];
  };
  attribution: { attested: number; violated: number; unattested: number };
  verdict: { passed: boolean; status: "passed" | "failed" | "incomplete"; reasons: string[] };
}

const ANONYMOUS = "system:moltnet.anonymous";
const PROVENANCE_KEYS = new Set(["simfile_event_id", "simfile_event_kind", "simfile_rule_id"]);
type JsonRecord = Record<string, unknown>;

const stableJson = (value: unknown): string => {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const object = value as JsonRecord;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`).join(",")}}`;
};

const hashParts = (parts: unknown[]): string => createHash("sha256").update(stableJson(parts)).digest("hex");

const principalMatches = (rendered: string, principal: string): boolean => {
  if (rendered === principal) return true;
  const identity = principal.match(/^(?:agent:|operator:token:)(.+)$/u)?.[1];
  return identity === rendered || identity?.replace(/-agent$/u, "") === rendered;
};

const isWorldSource = (message: SocialTranscriptMessage): boolean => {
  const rendered = message.rendered_attribution;
  return rendered === "world" || rendered === "@world" || rendered === "control" || rendered === "@control";
};

export const readSocialTranscript = async (runDir: string): Promise<SocialTranscriptMessage[]> => {
  const files = (await findRunRawFiles(runDir)).filter(({ rawRelativePath }) => {
    const segments = rawRelativePath.split(path.sep);
    return segments[0] === "raw" && segments[1] === "moltnet"
      && segments.at(-1) === "transcript.json";
  });
  const messages: SocialTranscriptMessage[] = [];
  for (const file of files) {
    const raw = JSON.parse(await readFile(file.absolutePath, "utf8")) as { conversations?: { messages?: JsonRecord[] }[] };
    for (const conversation of raw.conversations ?? []) for (const message of conversation.messages ?? []) {
      if (typeof message.id !== "string") continue;
      const from = typeof message.from === "object" && message.from !== null ? message.from as JsonRecord : {};
      const rendered = typeof from.name === "string" && from.name.length > 0
        ? from.name : typeof from.id === "string" ? from.id : "";
      messages.push({ id: message.id, rendered_attribution: rendered, parts: Array.isArray(message.parts) ? message.parts : [] });
    }
  }
  return messages;
};

const isDescendantOf = (event: CausalEvent, ancestorId: string, byId: Map<string, CausalEvent>, seen = new Set<string>()): boolean => {
  if (event.cause_event_ids.includes(ancestorId)) return true;
  if (seen.has(event.event_id)) return false;
  seen.add(event.event_id);
  return event.cause_event_ids.some((id) => {
    const cause = byId.get(id);
    return cause !== undefined && isDescendantOf(cause, ancestorId, byId, seen);
  });
};

export const computeSocialPlane = (
  messages: readonly SocialTranscriptMessage[],
  events: readonly CausalEvent[]
): SocialPlane => {
  const accepted = new Map<string, CausalEvent>();
  for (const event of events) {
    if (event.emitter.system === "moltnet" && event.type === "message.accepted" && typeof event.payload.message_id === "string") accepted.set(event.payload.message_id, event);
  }
  const byId = new Map(events.map((event) => [event.event_id, event] as const));
  const entries = messages.map((message) => {
    const acceptedEvent = accepted.get(message.id);
    const principal = acceptedEvent?.principal_id ?? null;
    const attribution = principal === null || principal === ANONYMOUS ? "unattested" : principalMatches(message.rendered_attribution, principal) ? "attested" : "violated";
    const expectedHash = acceptedEvent?.payload.content_sha256;
    return {
      message_id: message.id,
      rendered_attribution: message.rendered_attribution,
      authenticated_principal: principal,
      attribution,
      content_sha256_matches: typeof expectedHash === "string" && hashParts(message.parts) === expectedHash
    } satisfies SocialPlaneMessage;
  });
  const worldViolations = messages.flatMap((message) => {
    const keys = message.parts.flatMap((part) => {
      if (typeof part !== "object" || part === null) return [];
      const data = (part as JsonRecord).data;
      if (typeof data !== "object" || data === null || Array.isArray(data)) return [];
      return Object.keys(data as JsonRecord);
    }).filter((key, index, all) => all.indexOf(key) === index);
    const invalid = isWorldSource(message) ? keys.filter((key) => !PROVENANCE_KEYS.has(key)) : keys;
    return invalid.length > 0 ? [{ message_id: message.id, keys: invalid.sort() }] : [];
  });
  const actionViolations = events.flatMap((event) => {
    const action = typeof event.payload.action === "string" ? event.payload.action : undefined;
    if (!action || action === "moltnet:message" || event.type === "world.message") return [];
    return [...accepted.entries()].filter(([, messageEvent]) => isDescendantOf(event, messageEvent.event_id, byId)).map(([messageId]) => ({ message_id: messageId, action_event_id: event.event_id, relation: "causal-ancestor" as const }));
  });
  const attribution = { attested: entries.filter((entry) => entry.attribution === "attested").length, violated: entries.filter((entry) => entry.attribution === "violated").length, unattested: entries.filter((entry) => entry.attribution === "unattested").length };
  const reasons = [
    ...(worldViolations.length ? [`world state in ${worldViolations.length} social message(s)`] : []),
    ...(actionViolations.length ? [`${actionViolations.length} recorded action(s) causally descend from social message(s)`] : []),
    ...(attribution.violated ? [`${attribution.violated} forged attribution(s)`] : []),
    ...(entries.some((entry) => !entry.content_sha256_matches) ? ["one or more message content hashes do not match"] : [])
  ];
  const recordIncomplete = entries.some((entry) => !entry.content_sha256_matches) || entries.some((entry) => !accepted.has(entry.message_id));
  const clauseFailure = worldViolations.length > 0 || actionViolations.length > 0 || attribution.violated > 0;
  return {
    messages: { count: entries.length, entries },
    world_state: { passed: worldViolations.length === 0, violations: worldViolations },
    actions: { passed: actionViolations.length === 0, basis: "A violation is a recorded non-message world action whose causal ancestry includes message.accepted; this is the action/cause relation already used by worldEvidence.", violations: actionViolations },
    attribution,
    verdict: { passed: !clauseFailure && !recordIncomplete, status: clauseFailure ? "failed" : recordIncomplete ? "incomplete" : "passed", reasons }
  };
};
