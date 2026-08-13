import { canonicalDynamicsJson } from "../dynamics/canonicalJson.js";
import { DYNAMICS_LIMITS } from "../dynamics/limits.js";
import { copyHostileJson, type HostileJson } from "./hostileJson.js";
import { copySafeUint8Array } from "./decisionRegistrySnapshot.js";

export const WORLD_ACT_ENVELOPE_VERSION = "simfile.world-act-request.v1" as const;

export interface WorldActEnvelopeInput {
  readonly version?: typeof WORLD_ACT_ENVELOPE_VERSION;
  readonly request_id: string;
  readonly affordance: string;
  readonly target: string;
  readonly input: unknown;
}

export interface ParsedWorldActEnvelope {
  readonly version: typeof WORLD_ACT_ENVELOPE_VERSION;
  readonly request_id: string;
  readonly affordance: string;
  readonly target: string;
  readonly input: unknown;
  /** A frozen copy of the complete canonical wire identity. */
  readonly bytes: readonly number[];
}

const UTF8 = new TextEncoder();
const binding = (value: unknown): value is string => typeof value === "string"
  && value.length > 0 && value.length <= DYNAMICS_LIMITS.identifier_code_units && value === value.trim();
const fields = ["version", "request_id", "affordance", "target", "input"] as const;
const inputFields = ["request_id", "affordance", "target", "input"] as const;
const fail = (message = "invalid world action envelope"): never => { throw new TypeError(message); };
const equalBytes = (left: Uint8Array | readonly number[], right: Uint8Array | readonly number[]): boolean =>
  left.length === right.length && left.every((byte, index) => byte === right[index]);

const object = (value: HostileJson, expected: readonly string[] = fields): Readonly<Record<string, HostileJson>> | undefined => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const keys = Object.keys(value);
  return keys.length === expected.length && keys.every((key) => (expected as readonly string[]).includes(key))
    && expected.every((key) => Object.hasOwn(value, key)) ? value as Readonly<Record<string, HostileJson>> : undefined;
};

const checkEnvelope = (value: unknown): ParsedWorldActEnvelope => {
  const copy = copyHostileJson(value);
  const source = object(copy);
  if (source === undefined) throw new TypeError("invalid envelope object");
  const requestId = source.request_id; const affordance = source.affordance; const target = source.target;
  if (source.version !== WORLD_ACT_ENVELOPE_VERSION || typeof requestId !== "string" || typeof affordance !== "string"
    || typeof target !== "string" || !binding(requestId) || !binding(affordance) || !binding(target)) fail();
  const safeRequestId = requestId as string;
  const safeAffordance = affordance as string;
  const safeTarget = target as string;
  return Object.freeze({
    version: WORLD_ACT_ENVELOPE_VERSION,
    request_id: safeRequestId,
    affordance: safeAffordance,
    target: safeTarget,
    input: source.input,
    bytes: Object.freeze([] as number[]),
  });
};

const wire = (value: WorldActEnvelopeInput): Uint8Array => {
  const copy = copyHostileJson(value);
  const source = object(copy, Object.hasOwn(copy as object, "version") ? fields : inputFields);
  if (source === undefined) throw new TypeError("invalid envelope object");
  const requestId = source.request_id; const affordance = source.affordance; const target = source.target;
  if ((source.version !== undefined && source.version !== WORLD_ACT_ENVELOPE_VERSION)
    || !binding(requestId) || !binding(affordance) || !binding(target)) fail();
  const canonical = canonicalDynamicsJson({
    version: WORLD_ACT_ENVELOPE_VERSION,
    request_id: requestId,
    affordance,
    target,
    input: source.input,
  });
  return UTF8.encode(`${canonical}\n`);
};

export const encodeWorldActEnvelope = (input: unknown): Uint8Array => {
  try { return wire(input as WorldActEnvelopeInput); } catch { return fail(); }
};

export const parseWorldActEnvelope = (input: unknown): ParsedWorldActEnvelope => {
  try {
    const raw = copySafeUint8Array(input);
    if (raw === undefined) throw new TypeError("invalid envelope bytes");
    if (raw.byteLength === 0 || raw.byteLength > DYNAMICS_LIMITS.retained_action_code_units) fail();
    const text = new TextDecoder("utf-8", { fatal: true }).decode(raw);
    if (!text.endsWith("\n") || text.slice(0, -1).includes("\n")) fail("invalid envelope framing");
    const payload = text.slice(0, -1);
    let decoded: unknown;
    try { decoded = JSON.parse(payload); } catch { fail("invalid envelope JSON"); }
    const checked = checkEnvelope(decoded);
    const canonical = wire({ request_id: checked.request_id, affordance: checked.affordance, target: checked.target, input: checked.input });
    if (!equalBytes(raw, canonical)) fail("envelope is not canonical");
    return Object.freeze({ ...checked, bytes: Object.freeze(Array.from(raw)) });
  } catch { return fail(); }
};

export const tryParseWorldActEnvelope = (input: unknown): ParsedWorldActEnvelope | undefined => {
  try { return parseWorldActEnvelope(input); } catch { return undefined; }
};
